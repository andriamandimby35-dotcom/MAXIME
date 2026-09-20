import { NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createServerClient } from "@/lib/supabase/server";
import { toLoginEmail } from "@/lib/auth-identifier";

type ProjectRole = "works_manager" | "site_manager" | "viewer";

type InvitationPayload = {
  email?: string;
  password?: string;
  role?: ProjectRole;
  permissions?: Record<string, boolean>;
  parentAssignmentId?: string;
  confirmReplace?: boolean;
  phoneNumber?: string;
  mvolaEnabled?: boolean;
  callEnabled?: boolean;
  // "Conducteur associé" (works_manager uniquement) : même accès qu'un
  // conducteur normal, seule l'étiquette de paye change (voir plus bas,
  // fiche "Équipe déclarée" liée à ce compte).
  isAssociate?: boolean;
};

// Un conducteur ou un chef de chantier reçoit automatiquement sa propre
// fiche "Équipe déclarée", liée à son accès (linked_assignment_id) : il
// utilise ainsi exactement le même pointage de présence et le même calcul
// de paye que les employés, au lieu d'être compté présent depuis la
// création de son accès quel que soit l'avancement réel du chantier.
async function syncStaffLinkForAssignment(
  admin: ReturnType<typeof createAdminClient>,
  params: { organizationId: string; projectId: string; assignmentId: string; role: ProjectRole; fullName: string; isAssociate: boolean; phoneNumber: string | null; mvolaEnabled: boolean; callEnabled: boolean },
) {
  if (params.role === "viewer") return;
  const roleName = params.role === "works_manager" ? (params.isAssociate ? "Conducteur associé" : "Conducteur") : "Chef de chantier";
  const fields = {
    organization_id: params.organizationId,
    project_id: params.projectId,
    full_name: params.fullName,
    role_name: roleName,
    active: true,
    deleted_at: null,
    linked_assignment_id: params.assignmentId,
    mvola_number: params.phoneNumber,
    mvola_enabled: params.phoneNumber ? params.mvolaEnabled : false,
    call_enabled: params.phoneNumber ? params.callEnabled : false,
  };
  const { error } = await admin.from("project_staff_members").upsert(fields, { onConflict: "linked_assignment_id" });
  if (error?.code === "23505") {
    // Un employé déclaré porte déjà ce nom : on distingue la fiche du compte pour éviter le conflit d'unicité.
    const { error: retryError } = await admin.from("project_staff_members")
      .upsert({ ...fields, full_name: `${params.fullName} (accès)` }, { onConflict: "linked_assignment_id" });
    if (retryError) console.error("Fiche de présence non liée pour ce compte", retryError);
  } else if (error) {
    console.error("Fiche de présence non liée pour ce compte", error);
  }
}

type RevokePayload = {
  invitationId?: string;
  assignmentId?: string;
};

type InvitationUpdatePayload = {
  invitationId?: string;
  email?: string;
};

const validRoles = new Set<ProjectRole>(["works_manager", "site_manager", "viewer"]);

function safePermissions(value: unknown) {
  const permissions = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    reports: permissions.reports !== false,
    stock: permissions.stock !== false,
    photos: permissions.photos !== false,
  };
}

// Recherche un compte Auth existant par e-mail (utilisé pour détecter un
// identifiant déjà utilisé, par exemple par un accès supprimé auparavant).
async function findAuthUserByEmail(admin: ReturnType<typeof createAdminClient>, email: string) {
  const perPage = 200;
  for (let page = 1; page <= 25; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error || !data) return null;
    const match = data.users.find((item) => item.email?.trim().toLowerCase() === email);
    if (match) return match;
    if (data.users.length < perPage) return null;
  }
  return null;
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });

  let payload: InvitationPayload;
  try {
    payload = await request.json() as InvitationPayload;
  } catch {
    return NextResponse.json({ error: "Les informations de l'accès sont invalides." }, { status: 400 });
  }

  const identifier = String(payload.email ?? "").trim();
  const password = String(payload.password ?? "");
  const role = payload.role;
  if (!identifier || !role || !validRoles.has(role)) {
    return NextResponse.json({ error: "Saisissez un identifiant (nom ou e-mail) et un rôle autorisé." }, { status: 400 });
  }
  if (password.length < 6) {
    return NextResponse.json({ error: "Le mot de passe doit contenir au moins 6 caractères." }, { status: 400 });
  }
  // Un identifiant qui n'est pas une adresse e-mail (un simple nom, par
  // exemple) reçoit une adresse interne stable pour Supabase Auth, qui exige
  // toujours ce format — la personne continue de se connecter avec
  // l'identifiant tel qu'il a été saisi ici.
  const email = toLoginEmail(identifier);
  if (user.email?.trim().toLowerCase() === email) {
    return NextResponse.json({ error: "Cet identifiant est déjà celui de votre compte administrateur. Utilisez-en un autre pour créer le compte du conducteur." }, { status: 400 });
  }

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id, organization_id, progress_percent, status")
    .eq("id", projectId)
    .maybeSingle();
  if (projectError || !project) {
    return NextResponse.json({ error: "Chantier introuvable ou non autorisé." }, { status: 404 });
  }
  if (Number(project.progress_percent ?? 0) >= 100 || project.status === "completed") {
    return NextResponse.json({ error: "Ce chantier est terminé : les accès sont désactivés." }, { status: 409 });
  }

  const { data: membership } = await supabase
    .from("organization_members")
    .select("role, active")
    .eq("organization_id", project.organization_id)
    .eq("user_id", user.id)
    .maybeSingle();
  const isAdmin = Boolean(membership?.active && ["owner", "admin"].includes(membership.role));

  // Les vérifications et écritures d'équipe passent par le client serveur.
  // Elles ne doivent pas dépendre des politiques RLS de l'utilisateur invité.
  const admin = createAdminClient();
  const { data: ownManagerAssignment, error: managerAssignmentError } = await admin
    .from("project_assignments")
    .select("id")
    .eq("project_id", projectId)
    .eq("user_id", user.id)
    .eq("role", "works_manager")
    .eq("active", true)
    .maybeSingle();

  if (managerAssignmentError) {
    console.error("Impossible de vérifier l'accès conducteur", managerAssignmentError);
    return NextResponse.json({ error: "Impossible de vérifier vos droits de chantier." }, { status: 500 });
  }

  const isWorksManager = Boolean(ownManagerAssignment?.id);
  if (!isAdmin && !isWorksManager) {
    return NextResponse.json({ error: "Vous n'êtes pas autorisé à créer cet accès." }, { status: 403 });
  }
  if (isWorksManager && !isAdmin && role !== "site_manager") {
    return NextResponse.json({ error: "Vous n'êtes pas autorisé à créer cet accès." }, { status: 403 });
  }

  // Le conducteur créé un chef sous lui-même ; l'administrateur choisit sous
  // quel conducteur rattacher le chef qu'il crée directement.
  let parentAssignmentId: string | null = null;
  if (role === "site_manager") {
    if (isWorksManager && !isAdmin) {
      parentAssignmentId = ownManagerAssignment?.id ?? null;
    } else if (isAdmin) {
      const requestedParentId = String(payload.parentAssignmentId ?? "").trim();
      if (!requestedParentId) {
        return NextResponse.json({ error: "Choisissez le conducteur sous lequel rattacher ce chef de chantier." }, { status: 400 });
      }
      const { data: parentAssignment } = await admin
        .from("project_assignments")
        .select("id, project_id, role, active")
        .eq("id", requestedParentId)
        .maybeSingle();
      if (!parentAssignment || parentAssignment.project_id !== projectId || parentAssignment.role !== "works_manager" || !parentAssignment.active) {
        return NextResponse.json({ error: "Conducteur parent introuvable ou inactif." }, { status: 400 });
      }
      parentAssignmentId = parentAssignment.id;
    }
  }

  // Le compte est créé directement avec l'identifiant et le mot de passe
  // saisis par la personne qui l'invite (pas d'e-mail d'invitation à
  // envoyer) : elle transmet elle-même ces identifiants au collaborateur.
  // Si un compte existe déjà avec cet identifiant (souvent parce qu'il avait
  // été retiré d'un chantier auparavant — le compte Auth n'est jamais
  // supprimé lors d'un retrait), on demande confirmation avant de le
  // réactiver avec les nouvelles informations plutôt que de simplement
  // échouer.
  const confirmReplace = payload.confirmReplace === true;
  const existingUser = await findAuthUserByEmail(admin, email);

  let createdUserId: string;

  if (existingUser) {
    const existingOrgId = (existingUser.user_metadata as Record<string, unknown> | null)?.organization_id;
    if (existingOrgId && existingOrgId !== project.organization_id) {
      return NextResponse.json({ error: "Cet identifiant est déjà utilisé par un compte d'une autre entreprise. Choisissez un autre identifiant." }, { status: 409 });
    }
    if (!confirmReplace) {
      return NextResponse.json({
        error: "Un compte existe déjà avec cet identifiant (il a probablement été créé puis retiré d'un chantier auparavant).",
        conflict: true,
      }, { status: 409 });
    }
    const { data: updatedUser, error: updateUserError } = await admin.auth.admin.updateUserById(existingUser.id, {
      password,
      email_confirm: true,
      user_metadata: { organization_id: project.organization_id, project_id: projectId, project_role: role, identifier },
    });
    if (updateUserError || !updatedUser.user) {
      console.error("Réactivation du compte chantier impossible", updateUserError);
      return NextResponse.json({ error: `Compte non réactivé : ${updateUserError?.message ?? "erreur inconnue"}` }, { status: 500 });
    }
    createdUserId = updatedUser.user.id;
  } else {
    const { data: createdUser, error: createUserError } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { organization_id: project.organization_id, project_id: projectId, project_role: role, identifier },
    });
    if (createUserError || !createdUser.user) {
      const alreadyRegistered = /already|registered|exists|duplicate/i.test(createUserError?.message ?? "");
      console.error("Création du compte chantier impossible", createUserError);
      return NextResponse.json({
        error: alreadyRegistered
          ? "Un compte existe déjà avec cette adresse e-mail."
          : `Compte non créé : ${createUserError?.message ?? "erreur inconnue"}`,
        conflict: alreadyRegistered ? true : undefined,
      }, { status: alreadyRegistered ? 409 : 500 });
    }
    createdUserId = createdUser.user.id;
  }

  const memberRole = role === "works_manager" ? "works_manager" : "site_manager";
  const { error: memberError } = await admin
    .from("organization_members")
    .upsert(
      { organization_id: project.organization_id, user_id: createdUserId, role: memberRole, active: true },
      { onConflict: "organization_id,user_id" },
    );
  if (memberError) {
    console.error("Rattachement à l'organisation impossible", memberError);
    return NextResponse.json({ error: `Compte créé mais rattachement à l'organisation impossible : ${memberError.message}` }, { status: 500 });
  }

  // Si cette personne avait déjà un accès (même désactivé) sur ce chantier,
  // on met à jour cette ligne au lieu d'en créer une deuxième.
  const { data: existingAssignment } = await admin
    .from("project_assignments")
    .select("id")
    .eq("project_id", projectId)
    .eq("user_id", createdUserId)
    .maybeSingle();

  const phoneNumber = String(payload.phoneNumber ?? "").trim();
  const assignmentFields = {
    organization_id: project.organization_id,
    project_id: projectId,
    user_id: createdUserId,
    role,
    active: true,
    permissions: safePermissions(payload.permissions),
    parent_assignment_id: parentAssignmentId,
    assigned_by: user.id,
    access_password: password,
    phone_number: phoneNumber || null,
    mvola_enabled: phoneNumber ? payload.mvolaEnabled === true : false,
    call_enabled: phoneNumber ? payload.callEnabled === true : false,
  };

  const { data: assignment, error: assignmentError } = existingAssignment
    ? await admin.from("project_assignments").update(assignmentFields).eq("id", existingAssignment.id).select().single()
    : await admin.from("project_assignments").insert(assignmentFields).select().single();
  if (assignmentError || !assignment) {
    console.error("Accès chantier non enregistré", assignmentError);
    return NextResponse.json({ error: `Compte créé mais accès au chantier non enregistré : ${assignmentError?.message ?? "erreur inconnue"}` }, { status: 500 });
  }

  // Ne bloque jamais la création du compte : sans cette fiche, l'accès
  // fonctionne quand même, seul le pointage de présence resterait à relier
  // manuellement (l'administrateur peut réessayer en modifiant le compte).
  await syncStaffLinkForAssignment(admin, {
    organizationId: project.organization_id,
    projectId,
    assignmentId: assignment.id,
    role,
    fullName: identifier,
    isAssociate: payload.isAssociate === true,
    phoneNumber: phoneNumber || null,
    mvolaEnabled: payload.mvolaEnabled === true,
    callEnabled: payload.callEnabled === true,
  });

  return NextResponse.json({
    assignment: { ...assignment, email, displayName: identifier },
    message: existingAssignment
      ? "Compte réactivé avec les nouvelles informations : transmettez l'identifiant et le mot de passe à la personne concernée."
      : "Compte créé avec l'identifiant et le mot de passe saisis : transmettez-les à la personne concernée.",
  }, { status: 201 });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });

  let payload: InvitationUpdatePayload;
  try {
    payload = await request.json() as InvitationUpdatePayload;
  } catch {
    return NextResponse.json({ error: "Les informations de modification sont invalides." }, { status: 400 });
  }

  const invitationId = String(payload.invitationId ?? "").trim();
  const email = String(payload.email ?? "").trim().toLowerCase();
  if (!invitationId || !/^\S+@\S+\.\S+$/.test(email)) {
    return NextResponse.json({ error: "Adresse e-mail invalide." }, { status: 400 });
  }

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id, organization_id, progress_percent, status")
    .eq("id", projectId)
    .maybeSingle();
  if (projectError || !project) {
    return NextResponse.json({ error: "Chantier introuvable ou non autorisé." }, { status: 404 });
  }
  if (Number(project.progress_percent ?? 0) >= 100 || project.status === "completed") {
    return NextResponse.json({ error: "Ce chantier est terminé : les accès sont désactivés." }, { status: 409 });
  }

  const { data: membership } = await supabase
    .from("organization_members")
    .select("role, active")
    .eq("organization_id", project.organization_id)
    .eq("user_id", user.id)
    .maybeSingle();
  if (!(membership?.active && ["owner", "admin"].includes(membership.role))) {
    return NextResponse.json({ error: "Seul l’administrateur peut modifier une invitation." }, { status: 403 });
  }

  const admin = createAdminClient();
  const { data: invitation, error: invitationError } = await admin
    .from("project_access_invitations")
    .select("id, project_id, organization_id, status")
    .eq("id", invitationId)
    .maybeSingle();
  if (invitationError || !invitation || invitation.project_id !== project.id || invitation.organization_id !== project.organization_id) {
    return NextResponse.json({ error: "Invitation introuvable." }, { status: 404 });
  }
  if (invitation.status !== "pending") {
    return NextResponse.json({ error: "Seule une invitation en attente peut être modifiée." }, { status: 409 });
  }

  const { data: duplicate } = await admin
    .from("project_access_invitations")
    .select("id")
    .eq("organization_id", project.organization_id)
    .eq("project_id", projectId)
    .eq("email", email)
    .eq("status", "pending")
    .neq("id", invitationId)
    .maybeSingle();
  if (duplicate) {
    return NextResponse.json({ error: "Une invitation est déjà en attente pour cette adresse." }, { status: 409 });
  }

  const { data: updated, error: updateError } = await admin
    .from("project_access_invitations")
    .update({ email })
    .eq("id", invitationId)
    .select()
    .single();
  if (updateError || !updated) {
    return NextResponse.json({ error: "Adresse e-mail non modifiée." }, { status: 500 });
  }

  try {
    const { error: emailError } = await admin.auth.admin.inviteUserByEmail(email, {
      data: { organization_id: project.organization_id, project_id: projectId, project_role: updated.role },
      redirectTo: `${new URL(request.url).origin}/auth/callback`,
    });
    if (emailError) {
      const alreadyRegistered = /already|registered|exists|duplicate/i.test(emailError.message);
      return NextResponse.json({
        invitation: updated,
        emailSent: false,
        message: alreadyRegistered
          ? "Adresse e-mail mise à jour. Cette adresse possède déjà un compte : la personne peut se connecter directement avec son mot de passe habituel."
          : "Adresse e-mail mise à jour, mais le nouvel e-mail n'a pas pu être envoyé. Vérifiez la configuration e-mail de Supabase avant de réessayer.",
      });
    }
  } catch (error) {
    console.error("Service d'invitation chantier indisponible", error);
    return NextResponse.json({
      invitation: updated,
      emailSent: false,
      message: "Adresse e-mail mise à jour, mais le nouvel e-mail n'a pas pu être envoyé. Vérifiez la configuration e-mail de Supabase avant de réessayer.",
    });
  }

  return NextResponse.json({
    invitation: updated,
    emailSent: true,
    message: "Adresse e-mail mise à jour et nouvel e-mail d'invitation envoyé.",
  });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: projectId } = await params;
  const supabase = await createServerClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "Non autorisé." }, { status: 401 });

  let payload: RevokePayload;
  try {
    payload = await request.json() as RevokePayload;
  } catch {
    return NextResponse.json({ error: "Les informations de révocation sont invalides." }, { status: 400 });
  }

  if (!payload.invitationId && !payload.assignmentId) {
    return NextResponse.json({ error: "Choisissez un accès à retirer." }, { status: 400 });
  }

  const { data: project, error: projectError } = await supabase
    .from("projects")
    .select("id, organization_id")
    .eq("id", projectId)
    .maybeSingle();
  if (projectError || !project) {
    return NextResponse.json({ error: "Chantier introuvable ou non autorisé." }, { status: 404 });
  }

  const { data: membership } = await supabase
    .from("organization_members")
    .select("role, active")
    .eq("organization_id", project.organization_id)
    .eq("user_id", user.id)
    .maybeSingle();
  const isAdmin = Boolean(membership?.active && ["owner", "admin"].includes(membership.role));
  if (!isAdmin) {
    return NextResponse.json({ error: "Seul l’administrateur peut retirer un accès." }, { status: 403 });
  }

  const admin = createAdminClient();

  if (payload.invitationId) {
    const { data: invitation, error: invitationReadError } = await admin
      .from("project_access_invitations")
      .select("id, project_id, organization_id")
      .eq("id", payload.invitationId)
      .maybeSingle();
    if (invitationReadError) {
      console.error("Impossible de lire l’invitation à annuler", invitationReadError);
      return NextResponse.json({ error: "Impossible de vérifier l’invitation." }, { status: 500 });
    }
    if (!invitation || invitation.project_id !== project.id || invitation.organization_id !== project.organization_id) {
      return NextResponse.json({ error: "Invitation introuvable." }, { status: 404 });
    }

    const { error: invitationRevokeError } = await admin
      .from("project_access_invitations")
      .update({ status: "revoked", revoked_at: new Date().toISOString() })
      .eq("id", invitation.id);
    if (invitationRevokeError) {
      console.error("Impossible d’annuler l’invitation", invitationRevokeError);
      return NextResponse.json({ error: "Impossible d’annuler cet accès en attente." }, { status: 500 });
    }

    return NextResponse.json({
      message: "Invitation annulée. Aucun rapport, document, photo ou autre donnée déjà enregistrée n’a été supprimé.",
    });
  }

  const { data: assignment, error: assignmentReadError } = await admin
    .from("project_assignments")
    .select("id, project_id, organization_id, user_id")
    .eq("id", payload.assignmentId ?? "")
    .maybeSingle();
  if (assignmentReadError) {
    console.error("Impossible de lire l’accès à retirer", assignmentReadError);
    return NextResponse.json({ error: "Impossible de vérifier l’accès." }, { status: 500 });
  }
  if (!assignment || assignment.project_id !== project.id || assignment.organization_id !== project.organization_id) {
    return NextResponse.json({ error: "Accès introuvable." }, { status: 404 });
  }

  const { error: assignmentRevokeError } = await admin
    .from("project_assignments")
    .update({ active: false, revoked_at: new Date().toISOString() })
    .eq("id", assignment.id);
  if (assignmentRevokeError) {
    console.error("Impossible de retirer l’accès", assignmentRevokeError);
    return NextResponse.json({ error: "Impossible de retirer cet accès." }, { status: 500 });
  }

  // La fiche "Équipe déclarée" liée à ce compte (voir syncStaffLinkForAssignment)
  // est retirée avec lui, comme pour un employé, en gardant son historique.
  const { error: staffDeactivateError } = await admin
    .from("project_staff_members")
    .update({ active: false, deleted_at: new Date().toISOString() })
    .eq("linked_assignment_id", assignment.id);
  if (staffDeactivateError) console.error("Fiche de présence non désactivée", staffDeactivateError);

  const { data: account } = await admin.auth.admin.getUserById(assignment.user_id);
  const accountEmail = account.user?.email?.trim().toLowerCase();
  if (accountEmail) {
    const { error: invitationRevokeError } = await admin
      .from("project_access_invitations")
      .update({ status: "revoked" })
      .eq("organization_id", project.organization_id)
      .eq("project_id", project.id)
      .eq("email", accountEmail)
      .in("status", ["pending", "accepted"]);
    if (invitationRevokeError) {
      console.error("Impossible de marquer l’invitation comme révoquée", invitationRevokeError);
    }
  }

  return NextResponse.json({
    message: "Accès retiré. La personne ne peut plus accéder à ce chantier. Les rapports, photos, stocks et autres données déjà enregistrés restent conservés.",
  });
}
