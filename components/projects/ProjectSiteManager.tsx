"use client";

import Link from "next/link";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createClient } from "@/lib/supabase/client";
import { deleteOfflinePhoto, loadOfflinePhoto, saveOfflinePhoto } from "@/lib/offline-photos";
import { canonicalCityName, canonicalMaterialKey } from "@/lib/material-normalization";

type Project = { id: string; project_code?: string | null; name: string; location?: string | null; budget_amount?: number | string | null; progress_percent?: number | string | null; status?: string | null; planned_end_date?: string | null; source_tender_id?: string | null; source_estimate_id?: string | null; closed_at?: string | null };
type PriceItem = { id: string; project_id: string; position?: string | null; designation: string; unit?: string | null; quantity?: number | string | null; unit_price?: number | string | null; total?: number | string | null; is_internal?: boolean };
type ChecklistItem = { id: string; label: string; done: boolean };
type Task = { id: string; project_id: string; title: string; status: string; planned_start_date?: string | null; planned_end_date?: string | null; progress_percent: number | string; notes?: string | null; created_by?: string | null; created_at?: string; is_dao_task?: boolean; checklist?: ChecklistItem[] | null };
type Report = { id: string; project_id: string; report_date: string; weather?: string | null; workers_present: number | string; completed_work?: string | null; next_day_plan?: string | null; issues?: string | null; created_by?: string | null; created_at?: string };
type Material = { id: string; project_id: string; designation: string; unit: string; planned_quantity: number | string; on_site_quantity: number | string; required_tomorrow: number | string; required_week: number | string; minimum_stock: number | string; notes?: string | null; created_by?: string | null; created_at?: string };
type StockMovement = { id: string; project_id: string; material_id?: string | null; movement_type: string; quantity: number | string; movement_date: string; notes?: string | null; created_by?: string | null; created_at: string };
type SitePhoto = { id: string; project_id: string; report_id?: string | null; task_id?: string | null; storage_path: string; caption?: string | null; photo_type: string; captured_at: string; created_by?: string | null; created_at: string; deleted_at?: string | null };
type AiSuggestion = { id: string; project_id: string; suggestion_type: string; title: string; content: string; confidence?: number | string | null; status: string; user_response?: string | null; created_by?: string | null; created_at: string };
type NoteReadEntry = { user_id: string; read_at: string };
type RecordNote = { id: string; project_id: string; entity_type: string; entity_id: string; severity: "info" | "review" | "urgent" | string; title: string; content: string; created_at: string; created_by?: string | null; read_by?: NoteReadEntry[] | null; reply_content?: string | null; reply_severity?: "urgent" | "review" | "confirmation" | string | null; replied_by?: string | null; replied_at?: string | null; reply_read_by?: NoteReadEntry[] | null };
type PendingSync = { id: string; label: string; action: "insert" | "update" | "report" | "purchase"; table: string; rowId?: string; payload: Record<string, unknown>; createdAt: string };
// Rapport journalier mis de côté hors connexion : les infos du rapport, les
// mises à jour de planning/stock à rejouer, et les identifiants des photos
// gardées sur l'appareil (voir lib/offline-photos.ts) le temps de les envoyer.
type QueuedReportPayload = {
  reportInput: {
    p_project_id: string;
    p_report_date: string;
    p_weather: string | null;
    p_workers_present: number;
    p_completed_work: string | null;
    p_next_day_plan: string | null;
    p_issues: string | null;
    p_consumptions: Array<{ material_id: string; quantity: number }>;
  };
  taskUpdates: Array<{ task_id: string; progress_percent: number; status: string; checklist?: ChecklistItem[] }>;
  materialUpdates: Array<{ material_id: string; quantity: number }>;
  photoIds: string[];
};
// Validation d'un achat (photo de la facture/du matériau) mise de côté hors
// connexion : la photo est gardée sur l'appareil (voir lib/offline-photos.ts),
// le reste rejoue exactement la même validation qu'en ligne dès le retour du réseau.
type QueuedPurchasePayload = {
  orderId: string;
  purchasedQuantity: number;
  unitPrice: number;
  // La photo est conseillée mais plus obligatoire (voir uploadPurchaseEvidence) :
  // absente, aucune photo n'est mise de côté sur l'appareil.
  photoId?: string;
  transportMode: string | null;
  transportPrice: number | null;
  fournisseur?: string | null;
};
type ProjectAccessRole = "admin" | "works_manager" | "site_manager" | "viewer";
type Assignment = { id: string; user_id: string; role: string; active: boolean; permissions?: Record<string, boolean> | null; parent_assignment_id?: string | null; created_at?: string; email?: string | null; displayName?: string | null; access_password?: string | null; phone_number?: string | null; mvola_enabled?: boolean; call_enabled?: boolean; revoked_at?: string | null };
type Invitation = { id: string; email: string; role: string; status: string; permissions?: Record<string, boolean> | null; parent_assignment_id?: string | null; invited_by?: string | null; accepted_at?: string | null; created_at?: string };
type MaterialOrder = { id: string; project_id: string; material_id?: string | null; material_name: string; material_key: string; unit: string; quantity: number | string; unit_price: number | string; needed_date?: string | null; needed_timing?: "now" | "tomorrow" | "week" | null; status: "draft" | "submitted" | "approved" | "covered_by_stock" | "paid" | "rejected" | "cancelled" | string; notes?: string | null; requested_by?: string | null; validated_by?: string | null; request_group_id?: string | null; submitted_at?: string | null; approved_at?: string | null; approved_quantity?: number | string | null; stock_available_at_approval?: number | string | null; quantity_to_purchase?: number | string | null; purchased_quantity?: number | string | null; purchase_photo_path?: string | null; purchase_photo_caption?: string | null; paid_at?: string | null; seen_at?: string | null; created_at?: string };
type RoleHistoryEntry = { role_name: string; effective_from: string };
type StaffMember = { id: string; project_id: string; full_name: string; role_name?: string | null; active?: boolean; created_at?: string; mvola_number?: string | null; mvola_enabled?: boolean; call_enabled?: boolean; supervisor_assignment_id?: string | null; deleted_at?: string | null; linked_assignment_id?: string | null; role_history?: RoleHistoryEntry[] | null };
type DailyAttendance = { id: string; project_id: string; staff_member_id: string; report_date: string; present: boolean; recorded_by?: string | null; created_at?: string };
type ReportMaterialUsage = { id: string; project_id: string; report_id: string; material_id: string; quantity: number | string; unit: string; created_at?: string };

const number = (value: unknown) => Number(value) || 0;
const date = new Intl.DateTimeFormat("fr-FR");
const dateTime = new Intl.DateTimeFormat("fr-FR", { dateStyle: "short", timeStyle: "short" });
const isLocked = (createdAt?: string) => Boolean(createdAt && !createdAt.startsWith(new Date().toISOString().slice(0, 10)));
const materialKey = (value: string) => value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
// M\u00eame normalisation que la protection anti-doublon de la base (colonne
// g\u00e9n\u00e9r\u00e9e "designation_norm" de price_library) : sert \u00e0 d\u00e9tecter si un
// mat\u00e9riau existe d\u00e9j\u00e0 avant d'ins\u00e9rer, pour ne jamais d\u00e9clencher l'erreur
// d'unicit\u00e9 et surtout pour fusionner au lieu de dupliquer (voir
// addMaterialToLibrary / saveLibraryMaterialEdit ci-dessous).
const designationNormKey = (value: string) => String(value ?? "").toLowerCase().replace(/[^a-zA-Z0-9]/g, "");
// Identifiant d'une offre (fournisseur + lieu) dans la liste "fournisseurs"
// d'un mat\u00e9riau : deux offres du m\u00eame fournisseur au m\u00eame endroit sont mises
// \u00e0 jour l'une sur l'autre, sinon une nouvelle offre est ajout\u00e9e \u00e0 la liste.
type PriceOfferEntry = { fournisseur?: string | null; ville?: string | null; region?: string | null; prix?: number | string | null; disponibilite?: string | null; livraison?: string | null; date_prix?: string | null };
const offerKey = (offer: PriceOfferEntry) => `${materialKey(String(offer.fournisseur ?? ""))}|${materialKey(String(offer.ville || offer.region || ""))}`;
function mergeOffer(existingOffers: PriceOfferEntry[] | null | undefined, newOffer: PriceOfferEntry) {
  const offers = Array.isArray(existingOffers) ? existingOffers : [];
  const matchIndex = offers.findIndex((offer) => offerKey(offer) === offerKey(newOffer));
  const merged = matchIndex >= 0
    ? offers.map((offer, index) => (index === matchIndex ? newOffer : offer))
    : [...offers, newOffer];
  const cheapest = merged.reduce((best, offer) => (Number(offer.prix) < Number(best.prix) ? offer : best), merged[0]);
  return { merged, cheapest };
}
function phoneLink(phone?: string | null) {
  if (!phone) return null;
  return <a className="projectPhoneLink" href={`tel:${phone.replace(/\s+/g, "")}`} onClick={(event) => event.stopPropagation()}>{phone}</a>;
}

export function ProjectSiteManager({ organizationId, userId, accessRole = "admin", projectPage = false, assignments: initialAssignments = [], invitations: initialInvitations = [], projects: initialProjects, tasks: initialTasks, reports: initialReports, materials: initialMaterials, stockMovements: initialStockMovements, photos: initialPhotos, suggestions: initialSuggestions, notes: initialNotes, materialOrders: initialMaterialOrders = [], staffMembers: initialStaffMembers = [], attendance: initialAttendance = [], reportMaterialUsages: initialReportMaterialUsages = [], priceItems: initialPriceItems = [] }: { organizationId: string | null; userId?: string | null; accessRole?: ProjectAccessRole; projectPage?: boolean; assignments?: Assignment[]; invitations?: Invitation[]; projects: Project[]; tasks: Task[]; reports: Report[]; materials: Material[]; stockMovements: StockMovement[]; photos: SitePhoto[]; suggestions: AiSuggestion[]; notes: RecordNote[]; materialOrders?: MaterialOrder[]; staffMembers?: StaffMember[]; attendance?: DailyAttendance[]; reportMaterialUsages?: ReportMaterialUsage[]; priceItems?: PriceItem[] }) {
  const supabase = useMemo(() => createClient(), []);
  const today = new Date().toISOString().slice(0, 10);
  const [projects, setProjects] = useState(initialProjects);
  const [tasks, setTasks] = useState(initialTasks);
  const [reports, setReports] = useState(initialReports);
  const [materials, setMaterials] = useState(initialMaterials);
  const [stockMovements, setStockMovements] = useState(initialStockMovements);
  const [photos, setPhotos] = useState(initialPhotos);
  const [suggestions, setSuggestions] = useState(initialSuggestions);
  const [recordNotes, setRecordNotes] = useState(initialNotes);
  const [materialOrders, setMaterialOrders] = useState(initialMaterialOrders);
  const [staffMembers, setStaffMembers] = useState(initialStaffMembers);
  const [attendance, setAttendance] = useState(initialAttendance);
  const [reportMaterialUsages, setReportMaterialUsages] = useState(initialReportMaterialUsages);
  const [assignments, setAssignments] = useState(initialAssignments);
  const [invitations, setInvitations] = useState(initialInvitations);
  const [teamView, setTeamView] = useState<"create" | "team">("create");
  const [soundEnabled, setSoundEnabled] = useState(false);
  const [selectedId, setSelectedId] = useState(initialProjects[0]?.id ?? "");
  const [message, setMessage] = useState("");
  const [accessFeedback, setAccessFeedback] = useState<{ kind: "info" | "success" | "error"; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [accessPermissions, setAccessPermissions] = useState({ reports: true, stock: true, photos: true });
  const [online, setOnline] = useState(true);
  const [pendingSync, setPendingSync] = useState<PendingSync[]>([]);
  const [editingInvitation, setEditingInvitation] = useState<Invitation | null>(null);
  const [editingInvitationEmail, setEditingInvitationEmail] = useState("");
  const [createRole, setCreateRole] = useState(accessRole === "admin" ? "works_manager" : "site_manager");
  const [createParentAssignmentId, setCreateParentAssignmentId] = useState("");
  // "Conducteur associé" : même accès qu'un conducteur normal, mais une
  // étiquette de paye distincte (réglable séparément dans les Taux de paye,
  // par ex. à 0 le temps qu'il se familiarise) — voir /api/projects/[id]/access-invitations.
  const [createIsAssociate, setCreateIsAssociate] = useState(false);
  const [expandedRoster, setExpandedRoster] = useState<{ conductors: boolean; siteManagers: boolean; removed: boolean; removedStaff: boolean }>({ conductors: true, siteManagers: true, removed: false, removedStaff: false });
  const [viewingAssignment, setViewingAssignment] = useState<Assignment | null>(null);
  // Suppression/retrait par simple clic sur la ligne, au lieu d'un bouton
  // toujours visible : un clic révèle un petit bouton d'action (Retirer,
  // Supprimer…), un clic en dehors le referme sans rien faire.
  const [revealedKey, setRevealedKey] = useState<string | null>(null);
  const [editingRoleStaffId, setEditingRoleStaffId] = useState<string | null>(null);
  useEffect(() => {
    if (!revealedKey) return;
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as HTMLElement | null;
      if (target && target.closest("[data-revealable]")) return;
      setRevealedKey(null);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [revealedKey]);
  type PriceOffer = { fournisseur?: string | null; ville?: string | null; region?: string | null; prix?: number | string | null; disponibilite?: string | null; livraison?: string | null; date_prix?: string | null };
  type PriceLibraryOption = { id: string; designation: string; unite: string; prix_retenu: number | string | null; prix_actuel: number | string | null; prix_ia: number | string | null; statut_prix?: string | null; ville?: string | null; fournisseur?: string | null; fournisseurs?: PriceOffer[] | null };
  const [priceLibraryOptions, setPriceLibraryOptions] = useState<PriceLibraryOption[]>([]);
  // Demande de matériaux : petit assistant à sélection cliquée (matériau,
  // quantité, besoin), envoyée directement — plus d'étape « brouillon ».
  const [requestDraft, setRequestDraft] = useState<{ material: PriceLibraryOption | null; quantity: string; timing: "" | "now" | "tomorrow" | "week" }>({ material: null, quantity: "", timing: "" });
  const [openRequestField, setOpenRequestField] = useState<null | "material" | "timing">(null);
  const [requestMaterialSearch, setRequestMaterialSearch] = useState("");
  const [requestStatus, setRequestStatus] = useState<{ kind: "info" | "success" | "error"; text: string } | null>(null);
  const [viewingOrder, setViewingOrder] = useState<MaterialOrder | null>(null);
  // Quand un matériau a des offres dans plusieurs régions, on propose
  // automatiquement celle du chantier (voir matchedRegionGroup) — sauf si
  // l'utilisateur clique sur "changer" (forceRegionChoice), auquel cas un
  // simple choix de région s'affiche avant de valider l'achat.
  const [selectedPurchaseOffer, setSelectedPurchaseOffer] = useState<PriceOfferEntry | null>(null);
  const [forceRegionChoice, setForceRegionChoice] = useState(false);
  const [viewingRequestDetail, setViewingRequestDetail] = useState<MaterialOrder | null>(null);
  const [purchaseStatus, setPurchaseStatus] = useState<{ kind: "info" | "success" | "error"; text: string } | null>(null);
  const [transportChoiceOpen, setTransportChoiceOpen] = useState(false);
  const [selectedTransportMode, setSelectedTransportMode] = useState<string | null>(null);
  const [transportPriceOpen, setTransportPriceOpen] = useState(false);
  const [transportPriceDraft, setTransportPriceDraft] = useState("");
  const [selectedTransportPrice, setSelectedTransportPrice] = useState<number | null>(null);
  const [viewingAchats, setViewingAchats] = useState(false);
  const [addingMiscExpense, setAddingMiscExpense] = useState(false);
  const [miscExpenseDraft, setMiscExpenseDraft] = useState({ recipient: "", amount: "", note: "" });
  const [confirmingMiscExpense, setConfirmingMiscExpense] = useState(false);
  const [miscExpenseStatus, setMiscExpenseStatus] = useState<{ kind: "info" | "success" | "error"; text: string } | null>(null);
  const [newLibraryMaterial, setNewLibraryMaterial] = useState({ designation: "", unite: "U", fournisseur: "", ville: "", prix: "" });
  const [newLibraryStatus, setNewLibraryStatus] = useState<{ kind: "info" | "success" | "error"; text: string } | null>(null);
  const [editingLibraryMaterial, setEditingLibraryMaterial] = useState<PriceLibraryOption | null>(null);
  const [editingLibraryPrice, setEditingLibraryPrice] = useState("");
  const [editingLibraryVille, setEditingLibraryVille] = useState("");
  const [editingLibraryStatus, setEditingLibraryStatus] = useState<{ kind: "info" | "success" | "error"; text: string } | null>(null);
  const longPressTimer = useRef<number | null>(null);
  const longPressFiredRef = useRef(false);
  const [reportConsumptionDraft, setReportConsumptionDraft] = useState<Array<{ material_id: string; quantity: number }>>([]);
  // Brouillon du rapport journalier : rien n'est écrit tant que « Valider et
  // envoyer le rapport » n'a pas été cliqué (sauf la présence, en direct).
  const [reportDraft, setReportDraft] = useState({ date: today, weather: "", completedWork: "", nextDayPlan: "", issues: "" });
  const [reportSelectedTasks, setReportSelectedTasks] = useState<Array<{ task_id: string; progress_percent: number; status: string; checklist?: ChecklistItem[] }>>([]);
  const [reportTomorrowTaskIds, setReportTomorrowTaskIds] = useState<string[]>([]);
  const [reportTomorrowMaterials, setReportTomorrowMaterials] = useState<Array<{ material_id: string; quantity: number }>>([]);
  const [reportPhotoDraft, setReportPhotoDraft] = useState<Array<{ id: string; file: File; previewUrl: string }>>([]);
  const [openReportField, setOpenReportField] = useState<null | "date" | "weather" | "workers" | "materials" | "tomorrowMaterials" | "completedWork" | "nextDayPlan">(null);
  const [materialQtyTarget, setMaterialQtyTarget] = useState<Material | null>(null);
  const [materialQtyStatus, setMaterialQtyStatus] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const [tomorrowQtyStatus, setTomorrowQtyStatus] = useState<{ kind: "info" | "error"; text: string } | null>(null);
  const [taskChecklistTarget, setTaskChecklistTarget] = useState<Task | null>(null);
  const [tomorrowMaterialQtyTarget, setTomorrowMaterialQtyTarget] = useState<Material | null>(null);
  const [reportSubmitting, setReportSubmitting] = useState(false);
  const [viewingReportSummary, setViewingReportSummary] = useState(false);
  const [reportSubmitStatus, setReportSubmitStatus] = useState<{ kind: "info" | "success" | "error"; text: string } | null>(null);
  const [viewingTomorrowSummary, setViewingTomorrowSummary] = useState(false);
  const [viewingStockDetail, setViewingStockDetail] = useState(false);
  const [viewingAttendanceDetail, setViewingAttendanceDetail] = useState(false);
  const [viewingReportDetail, setViewingReportDetail] = useState<Report | null>(null);
  const [viewingPhotoUrl, setViewingPhotoUrl] = useState<string | null>(null);
  const [viewingPhotoRecord, setViewingPhotoRecord] = useState<SitePhoto | null>(null);
  const [photoThumbnails, setPhotoThumbnails] = useState<Record<string, string>>({});
  const [aiAnalysisStatus, setAiAnalysisStatus] = useState<{ kind: "info" | "success" | "error"; text: string } | null>(null);
  const [aiAnalysisResult, setAiAnalysisResult] = useState<{ verdict: string; confidence: number; summary: string; observations: string[] } | null>(null);
  const [viewingNoteDetail, setViewingNoteDetail] = useState<RecordNote | null>(null);
  const [replyDraft, setReplyDraft] = useState<{ severity: string; content: string }>({ severity: "review", content: "" });
  const [viewingAttendanceDay, setViewingAttendanceDay] = useState<string | null>(null);
  const [viewingDeletedPhotos, setViewingDeletedPhotos] = useState(false);
  const [viewingMyRequestsHistory, setViewingMyRequestsHistory] = useState(false);
  const [viewingAdminOrdersHistory, setViewingAdminOrdersHistory] = useState(false);
  const [modalInputValue, setModalInputValue] = useState("");
  const [checklistStatus, setChecklistStatus] = useState<{ kind: "info" | "success" | "error"; text: string } | null>(null);
  const [viewingNotes, setViewingNotes] = useState(false);
  const WEATHER_OPTIONS = ["Ensoleillé", "Nuageux", "Pluvieux", "Orageux", "Brumeux"];
  const project = projects.find((item) => item.id === selectedId) ?? null;
  const projectTasks = tasks.filter((item) => item.project_id === selectedId);
  const projectReports = reports.filter((item) => item.project_id === selectedId).sort((a, b) => b.report_date.localeCompare(a.report_date));
  const projectMaterials = materials.filter((item) => item.project_id === selectedId);
  const projectReportMaterialUsages = reportMaterialUsages.filter((item) => item.project_id === selectedId);
  const projectAllStockMovements = stockMovements.filter((item) => item.project_id === selectedId).sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  const projectStockMovements = projectAllStockMovements.slice(0, 5);
  const projectPhotos = photos.filter((item) => item.project_id === selectedId && !item.deleted_at).sort((a, b) => b.captured_at.localeCompare(a.captured_at));
  const deletedProjectPhotos = photos.filter((item) => item.project_id === selectedId && item.deleted_at).sort((a, b) => (b.deleted_at || "").localeCompare(a.deleted_at || ""));
  const unassignedProjectPhotos = projectPhotos.filter((item) => !item.report_id);
  const projectSuggestions = suggestions.filter((item) => item.project_id === selectedId).slice(0, 5);
  const projectNotes = recordNotes.filter((item) => item.project_id === selectedId).slice(0, 12);
  const noteOriginalUnread = (note: RecordNote) => note.created_by !== userId && !(note.read_by ?? []).some((entry) => entry.user_id === userId);
  const noteReplyUnread = (note: RecordNote) => Boolean(note.reply_content) && note.replied_by !== userId && !(note.reply_read_by ?? []).some((entry) => entry.user_id === userId);
  const noteSeverityLabel = (severity: string) => severity === "urgent" ? "ERREUR GRAVE" : severity === "review" ? "À CONTRÔLER" : "INFORMATION";
  const replySeverityLabel = (severity?: string | null) => severity === "urgent" ? "Erreur grave" : severity === "review" ? "Point à contrôler" : severity === "confirmation" ? "Confirmation" : "Réponse";
  const unreadNotes = projectNotes.filter((note) => noteOriginalUnread(note) || noteReplyUnread(note));
  const allProjectNotes = recordNotes.filter((item) => item.project_id === selectedId).sort((a, b) => b.created_at.localeCompare(a.created_at));
  const readerName = (readerId: string) => {
    if (readerId === userId) return "Vous";
    const match = assignments.find((item) => item.user_id === readerId);
    // Un accès tout juste créé n'a pas encore de displayName (calculé
    // seulement au chargement serveur) : on retombe sur l'e-mail plutôt que
    // sur "Admin" par défaut, sinon un conducteur ou chef fraîchement créé
    // se voit faussement attribué à l'administrateur.
    return match?.displayName || match?.email?.split("@")[0] || "Admin";
  };
  const projectMaterialOrders = materialOrders.filter((item) => item.project_id === selectedId).sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  const projectStaff = staffMembers.filter((item) => item.project_id === selectedId && item.active !== false);
  // Étiquette affichée pour un compte conducteur/chef dans la liste des
  // accès : reprend le libellé de sa fiche "Équipe déclarée" liée (donc
  // "Conducteur associé" au lieu de "Conducteur" si la case a été cochée à
  // la création), sinon retombe sur le libellé générique du rôle.
  const conductorLabel = (assignmentId: string, fallback: string) =>
    staffMembers.find((item) => item.linked_assignment_id === assignmentId)?.role_name || fallback;
  // Trace des retraits : gardée visible (avec la date) au lieu de disparaître.
  const removedStaff = staffMembers.filter((item) => item.project_id === selectedId && item.active === false && item.deleted_at)
    .sort((a, b) => (b.deleted_at || "").localeCompare(a.deleted_at || ""));
  const pendingInvitations = invitations.filter((item) => item.status === "pending");
  // Un accès est réellement actif lorsqu'un compte a accepté l'invitation et
  // possède une affectation projet. Les invitations seules restent « en attente ».
  const activeConductors = assignments.filter((item) => item.role === "works_manager" && item.active);
  const pendingConductors = invitations.filter((item) => item.role === "works_manager" && item.status === "pending");
  const activeSiteManagers = assignments.filter((item) => item.role === "site_manager" && item.active);
  const pendingSiteManagers = invitations.filter((item) => item.role === "site_manager" && item.status === "pending");
  // Trace des accès retirés (conducteurs et chefs), avec la date de retrait.
  const removedAssignments = assignments.filter((item) => !item.active && item.revoked_at)
    .sort((a, b) => (b.revoked_at || "").localeCompare(a.revoked_at || ""));
  const projectAttendance = attendance.filter((item) => item.project_id === selectedId).sort((a, b) => b.report_date.localeCompare(a.report_date));
  const todayAttendance = projectAttendance.filter((item) => item.report_date === today);
  const isAdmin = accessRole === "admin";
  const isSiteManager = accessRole === "site_manager";
  const projectFinished = Boolean(project && (number(project.progress_percent) >= 100 || project.status === "completed"));
  const canOperate = !projectFinished && (accessRole === "works_manager" || accessRole === "site_manager");
  const canInvite = !projectFinished && (isAdmin || accessRole === "works_manager");
  const ownAssignment = assignments.find((item) => item.user_id === userId && item.active);
  // Un conducteur ou un chef de chantier a désormais sa propre fiche dans
  // "Équipe déclarée" (créée automatiquement avec son accès, voir
  // /api/projects/[id]/access-invitations) : il apparaît donc simplement
  // dans projectStaff, avec le même bouton présent/absent et le même calcul
  // de paye que les employés — plus de liste séparée ni de présence
  // automatique depuis la création de l'accès (voir todayReport /
  // attendanceMismatch plus bas pour le contrôle de cohérence avec le
  // rapport du soir).
  const todayReport = projectReports.find((item) => item.report_date === today);
  const todayPresentCount = todayAttendance.filter((item) => item.present).length;
  const attendanceMismatch = Boolean(todayReport && number(todayReport.workers_present) !== todayPresentCount);
  // Le droit « Stocks » est choisi lors de la création de l'accès. Il couvre
  // l'ajout de matériaux, les mouvements et la correction de ses propres saisies du jour.
  const canManageStock = canOperate && ownAssignment?.permissions?.stock === true;
  const canManageExpenses = !projectFinished && (isAdmin || (canOperate && ownAssignment?.permissions?.stock === true));
  const canUploadPurchaseEvidence = !projectFinished && (isAdmin || (canOperate && ownAssignment?.permissions?.photos === true));
  const canRecordAttendance = canOperate && ownAssignment?.permissions?.reports === true;
  const canUseReportStock = canRecordAttendance && ownAssignment?.permissions?.stock === true;
  const canEditOwnCurrentRecord = (record: { created_by?: string | null; created_at?: string }) => canOperate && record.created_by === userId && !isLocked(record.created_at);
  const noteTargets = [
    ...projectTasks.map((item) => ({ type: "task", id: item.id, label: `Étape — ${item.title}` })),
    ...projectReports.map((item) => ({ type: "daily_report", id: item.id, label: `Rapport — ${item.report_date}` })),
    ...projectMaterials.map((item) => ({ type: "material", id: item.id, label: `Matériau — ${item.designation}` })),
    ...projectStockMovements.map((item) => ({ type: "stock_movement", id: item.id, label: `Mouvement — ${item.movement_date}` })),
    ...projectPhotos.map((item) => ({ type: "photo", id: item.id, label: `Photo — ${item.caption || item.captured_at}` })),
    ...projectSuggestions.map((item) => ({ type: "suggestion", id: item.id, label: `Recommandation — ${item.title}` })),
  ];
  const averageProgress = projectTasks.length ? Math.round(projectTasks.reduce((sum, item) => sum + number(item.progress_percent), 0) / projectTasks.length) : number(project?.progress_percent);
  const lowStock = projectMaterials.filter((item) => number(item.on_site_quantity) < Math.max(number(item.minimum_stock), number(item.required_tomorrow)));
  const priceLibraryPrice = (option: PriceLibraryOption) => number(option.prix_retenu) || number(option.prix_actuel) || number(option.prix_ia);
  // Retrouve la fiche de la bibliothèque de prix correspondant à une demande
  // de matériau (par nom, comme le reste du fichier), pour savoir si elle a
  // plusieurs fournisseurs enregistrés et proposer le choix avant l'achat.
  const priceOptionForOrder = (order: MaterialOrder) => {
    const key = order.material_key || materialKey(order.material_name);
    return priceLibraryOptions.find((option) => materialKey(option.designation) === key) || null;
  };
  const offersForOrder = (order: MaterialOrder): PriceOfferEntry[] => {
    const option = priceOptionForOrder(order);
    return Array.isArray(option?.fournisseurs) ? (option!.fournisseurs as PriceOfferEntry[]) : [];
  };
  const viewingOrderOffers = viewingOrder ? offersForOrder(viewingOrder) : [];
  // Un même matériau peut avoir des offres dans plusieurs régions : on
  // regroupe par région/ville (pas fournisseur par fournisseur, pas de fiche
  // détaillée) pour rester simple — juste un choix de région si besoin.
  type RegionOfferGroup = { key: string; label: string; offers: PriceOfferEntry[] };
  const viewingOrderRegionGroups: RegionOfferGroup[] = (() => {
    const groups = new Map<string, RegionOfferGroup>();
    for (const offer of viewingOrderOffers) {
      const label = (offer.region || offer.ville || "Non précisé").trim() || "Non précisé";
      const key = materialKey(label) || "autre";
      if (!groups.has(key)) groups.set(key, { key, label, offers: [] });
      groups.get(key)!.offers.push(offer);
    }
    return [...groups.values()];
  })();
  const cheapestInRegionGroup = (group: RegionOfferGroup) => group.offers.reduce((best, offer) => (Number(offer.prix) < Number(best.prix) ? offer : best), group.offers[0]);
  // La localisation du chantier (renseignée à sa création) est comparée aux
  // régions/villes des offres : si l'une correspond, on la propose
  // automatiquement au lieu de demander — sinon un simple choix de région
  // s'affiche (voir plus bas).
  const matchedRegionGroup = (() => {
    const chantierLocation = (project?.location || "").trim();
    if (!chantierLocation || viewingOrderRegionGroups.length <= 1) return null;
    const locationKey = materialKey(chantierLocation);
    const locationCityKey = canonicalCityName(chantierLocation);
    return viewingOrderRegionGroups.find((group) => {
      if (!group.key) return false;
      const groupCityKey = canonicalCityName(group.label);
      return locationKey.includes(group.key) || group.key.includes(locationKey) || locationCityKey === groupCityKey;
    }) || null;
  })();
  const viewingOrderNeedsRegionChoice = Boolean(
    viewingOrder && viewingOrder.status !== "covered_by_stock" && viewingOrderRegionGroups.length > 1
      && !selectedPurchaseOffer && (!matchedRegionGroup || forceRegionChoice),
  );
  const effectiveOffer = selectedPurchaseOffer || (matchedRegionGroup && !forceRegionChoice ? cheapestInRegionGroup(matchedRegionGroup) : null);
  const requestMaterialMatches = useMemo(() => {
    // Recherche par mots-clés (même principe que la bibliothèque de prix) :
    // "fer d8" ou "fer 8" ne montre que les matériaux qui contiennent TOUS
    // ces mots (peu importe l'ordre), pas juste ceux qui contiennent la
    // phrase exacte. canonicalMaterialKey garde aussi les équivalences déjà
    // en place (Ø = D, mm/cm/kg/t, accents, majuscules...) des deux côtés.
    const tokens = canonicalMaterialKey(requestMaterialSearch).split(" ").filter(Boolean);
    const base = tokens.length
      ? priceLibraryOptions.filter((option) => {
          const designationKey = canonicalMaterialKey(option.designation);
          return tokens.every((token) => designationKey.includes(token));
        })
      : priceLibraryOptions;
    return base.slice(0, 60);
  }, [requestMaterialSearch, priceLibraryOptions]);
  const TIMING_LABELS: Record<string, string> = { now: "Maintenant", tomorrow: "Demain", week: "Dans la semaine" };
  const TRANSPORT_MODE_LABELS: Record<string, string> = { homme: "Homme", charrette: "Charrette", camionnette: "Camionnette", camion: "Camion", autre: "Autre" };
  const tomorrowMaterialsAvailability = reportTomorrowMaterials.map((item) => {
    const material = projectMaterials.find((m) => m.id === item.material_id);
    const usedToday = reportConsumptionDraft.find((usage) => usage.material_id === item.material_id)?.quantity || 0;
    const available = Math.max(0, number(material?.on_site_quantity) - usedToday);
    const shortfall = Math.max(0, item.quantity - available);
    return { item, material, available, shortfall };
  });
  const tomorrowMaterialShortfalls = tomorrowMaterialsAvailability.filter((row) => row.shortfall > 0);
  const myMaterialOrdersHistory = projectMaterialOrders.filter((item) => item.requested_by === userId && item.status !== "submitted").sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  const allOrdersHistory = projectMaterialOrders.filter((item) => item.status !== "submitted").sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
  const pendingApprovalOrders = projectMaterialOrders.filter((item) => item.status === "submitted");
  const unseenOrdersForAdmin = pendingApprovalOrders.filter((item) => !item.seen_at);
  const validatedOrdersToPurchase = projectMaterialOrders.filter((item) => item.status === "approved" || item.status === "covered_by_stock");
  const paidOrdersHistory = projectMaterialOrders.filter((item) => item.status === "paid").sort((a, b) => String(b.paid_at || "").localeCompare(String(a.paid_at || "")));
  const orderStatusLabel = (order: MaterialOrder) => {
    if (order.status === "paid") return "Achetée";
    if (order.status === "rejected") return "Rejetée";
    if (order.status === "approved" || order.status === "covered_by_stock") return "Validée";
    if (order.status === "submitted") return order.seen_at ? "En attente" : "Envoyée";
    return order.status;
  };

  // La fonction de synchro change à chaque rendu (elle lit pendingSync/online
  // à jour) ; la référence permet à l'écouteur "online" ci-dessous, monté une
  // seule fois, d'appeler toujours sa version la plus récente.
  const synchronizePendingRef = useRef<() => void>(() => {});
  useEffect(() => { synchronizePendingRef.current = () => void synchronizePending(); });

  const messagingCardRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const key = "btp-project-pending-sync";
    const readQueue = () => { try { setPendingSync(JSON.parse(localStorage.getItem(key) || "[]")); } catch { setPendingSync([]); } };
    const initialize = window.setTimeout(() => { setOnline(navigator.onLine); readQueue(); setSoundEnabled(localStorage.getItem("btp-project-note-sound") === "enabled"); }, 0);
    const onOnline = () => { setOnline(true); readQueue(); synchronizePendingRef.current(); };
    const onOffline = () => setOnline(false);
    window.addEventListener("online", onOnline); window.addEventListener("offline", onOffline);
    return () => { window.clearTimeout(initialize); window.removeEventListener("online", onOnline); window.removeEventListener("offline", onOffline); };
  }, []);

  async function refreshPriceLibrary() {
    if (!organizationId || !online) return;
    const { data } = await supabase.from("price_library").select("id,designation,unite,prix_retenu,prix_actuel,prix_ia,statut_prix,ville,fournisseur,fournisseurs").eq("organization_id", organizationId);
    if (data) setPriceLibraryOptions(data);
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshPriceLibrary(), 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organizationId, online]);

  useEffect(() => {
    localStorage.setItem("btp-project-record-notes", JSON.stringify(recordNotes));
  }, [recordNotes]);

  useEffect(() => {
    if (initialNotes.length) return;
    const timer = window.setTimeout(() => {
      try {
        const cached = JSON.parse(localStorage.getItem("btp-project-record-notes") || "[]") as RecordNote[];
        if (cached.length) setRecordNotes(cached);
      } catch { /* Un cache local corrompu est simplement ignoré. */ }
    }, 0);
    return () => window.clearTimeout(timer);
  }, [initialNotes.length]);

  useEffect(() => {
    if (!online || !selectedId) return;
    const refreshNotes = async () => {
      const { data } = await supabase.from("project_record_notes").select("*").eq("project_id", selectedId).order("created_at", { ascending: false });
      if (data) setRecordNotes((previous) => [...data, ...previous.filter((item) => item.project_id !== selectedId || item.id.startsWith("local-"))]);
    };
    const timer = window.setInterval(() => void refreshNotes(), 30_000);
    return () => window.clearInterval(timer);
  }, [online, selectedId, supabase]);

  // Diffusion instantanée des remarques : un nouveau message ou une lecture
  // par un collègue apparaît sans attendre le prochain rafraîchissement.
  useEffect(() => {
    if (!selectedId) return;
    const channel = supabase
      .channel(`project-notes-${selectedId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "project_record_notes", filter: `project_id=eq.${selectedId}` },
        (payload) => {
          const row = payload.new as RecordNote;
          setRecordNotes((rows) => rows.some((item) => item.id === row.id) ? rows : [row, ...rows]);
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "project_record_notes", filter: `project_id=eq.${selectedId}` },
        (payload) => {
          const row = payload.new as RecordNote;
          setRecordNotes((rows) => rows.map((item) => item.id === row.id ? row : item));
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [selectedId, supabase]);

  // Idem pour les demandes de matériaux : nouvelle demande, prise en compte
  // ou validation apparaissent en direct chez l'administrateur et le demandeur.
  useEffect(() => {
    if (!selectedId) return;
    const channel = supabase
      .channel(`project-orders-${selectedId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "project_material_orders", filter: `project_id=eq.${selectedId}` },
        (payload) => {
          const row = payload.new as MaterialOrder;
          setMaterialOrders((rows) => rows.some((item) => item.id === row.id) ? rows : [row, ...rows]);
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "project_material_orders", filter: `project_id=eq.${selectedId}` },
        (payload) => {
          const row = payload.new as MaterialOrder;
          setMaterialOrders((rows) => rows.map((item) => item.id === row.id ? row : item));
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [selectedId, supabase]);

  // Idem pour le magasin : un achat validé ou une consommation déclarée
  // met à jour le stock et l'historique chez tout le monde sans rechargement.
  useEffect(() => {
    if (!selectedId) return;
    const channel = supabase
      .channel(`project-stock-${selectedId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "project_stock_movements", filter: `project_id=eq.${selectedId}` },
        (payload) => {
          const row = payload.new as StockMovement;
          setStockMovements((rows) => rows.some((item) => item.id === row.id) ? rows : [row, ...rows]);
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "project_materials", filter: `project_id=eq.${selectedId}` },
        (payload) => {
          const row = payload.new as Material;
          setMaterials((rows) => rows.some((item) => item.id === row.id) ? rows : [...rows, row]);
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "project_materials", filter: `project_id=eq.${selectedId}` },
        (payload) => {
          const row = payload.new as Material;
          setMaterials((rows) => rows.map((item) => item.id === row.id ? row : item));
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [selectedId, supabase]);

  // Accès (comptes conducteur/chef), équipe déclarée et présence du jour :
  // un retrait, un ajout ou un pointage fait par un autre poste (ou par
  // l'administrateur) apparaît en direct, sans avoir besoin de rafraîchir.
  useEffect(() => {
    if (!selectedId) return;
    const channel = supabase
      .channel(`project-team-${selectedId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "project_assignments", filter: `project_id=eq.${selectedId}` },
        (payload) => {
          const row = payload.new as Assignment;
          setAssignments((rows) => rows.some((item) => item.id === row.id) ? rows : [row, ...rows]);
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "project_assignments", filter: `project_id=eq.${selectedId}` },
        (payload) => {
          const row = payload.new as Assignment;
          setAssignments((rows) => rows.map((item) => item.id === row.id ? { ...item, ...row } : item));
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "project_access_invitations", filter: `project_id=eq.${selectedId}` },
        (payload) => {
          const row = payload.new as Invitation;
          setInvitations((rows) => rows.some((item) => item.id === row.id) ? rows : [row, ...rows]);
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "project_access_invitations", filter: `project_id=eq.${selectedId}` },
        (payload) => {
          const row = payload.new as Invitation;
          setInvitations((rows) => rows.map((item) => item.id === row.id ? row : item));
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "project_staff_members", filter: `project_id=eq.${selectedId}` },
        (payload) => {
          const row = payload.new as StaffMember;
          setStaffMembers((rows) => rows.some((item) => item.id === row.id) ? rows : [...rows, row]);
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "project_staff_members", filter: `project_id=eq.${selectedId}` },
        (payload) => {
          const row = payload.new as StaffMember;
          setStaffMembers((rows) => rows.map((item) => item.id === row.id ? row : item));
        },
      )
      .on(
        "postgres_changes",
        { event: "DELETE", schema: "public", table: "project_staff_members" },
        (payload) => {
          const oldRow = payload.old as { id?: string };
          if (!oldRow.id) return;
          setStaffMembers((rows) => rows.filter((item) => item.id !== oldRow.id));
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "project_daily_attendance", filter: `project_id=eq.${selectedId}` },
        (payload) => {
          const row = payload.new as DailyAttendance;
          setAttendance((rows) => rows.some((item) => item.id === row.id) ? rows : [row, ...rows]);
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "project_daily_attendance", filter: `project_id=eq.${selectedId}` },
        (payload) => {
          const row = payload.new as DailyAttendance;
          setAttendance((rows) => rows.map((item) => item.id === row.id ? row : item));
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [selectedId, supabase]);

  // Idem pour les rapports journaliers : un rapport envoyé par un autre poste
  // (avec ses photos et consommations) apparaît en direct, sans rechargement.
  useEffect(() => {
    if (!selectedId) return;
    const channel = supabase
      .channel(`project-reports-${selectedId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "project_daily_reports", filter: `project_id=eq.${selectedId}` },
        (payload) => {
          const row = payload.new as Report;
          setReports((rows) => rows.some((item) => item.id === row.id) ? rows : [row, ...rows]);
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "project_daily_reports", filter: `project_id=eq.${selectedId}` },
        (payload) => {
          const row = payload.new as Report;
          setReports((rows) => rows.map((item) => item.id === row.id ? row : item));
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "project_photos", filter: `project_id=eq.${selectedId}` },
        (payload) => {
          const row = payload.new as SitePhoto;
          setPhotos((rows) => rows.some((item) => item.id === row.id) ? rows : [row, ...rows]);
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "project_report_material_usages", filter: `project_id=eq.${selectedId}` },
        (payload) => {
          const row = payload.new as ReportMaterialUsage;
          setReportMaterialUsages((rows) => rows.some((item) => item.id === row.id) ? rows : [row, ...rows]);
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [selectedId, supabase]);

  // Idem pour les tâches du planning et les suggestions IA : une mise à jour
  // faite par un autre poste (avancement, statut, réponse à une suggestion)
  // apparaît en direct, sans rechargement.
  useEffect(() => {
    if (!selectedId) return;
    const channel = supabase
      .channel(`project-tasks-${selectedId}`)
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "project_tasks", filter: `project_id=eq.${selectedId}` },
        (payload) => {
          const row = payload.new as Task;
          setTasks((rows) => rows.some((item) => item.id === row.id) ? rows : [...rows, row]);
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "project_tasks", filter: `project_id=eq.${selectedId}` },
        (payload) => {
          const row = payload.new as Task;
          setTasks((rows) => rows.map((item) => item.id === row.id ? { ...item, ...row } : item));
        },
      )
      .on(
        "postgres_changes",
        { event: "INSERT", schema: "public", table: "project_ai_suggestions", filter: `project_id=eq.${selectedId}` },
        (payload) => {
          const row = payload.new as AiSuggestion;
          setSuggestions((rows) => rows.some((item) => item.id === row.id) ? rows : [row, ...rows]);
        },
      )
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "project_ai_suggestions", filter: `project_id=eq.${selectedId}` },
        (payload) => {
          const row = payload.new as AiSuggestion;
          setSuggestions((rows) => rows.map((item) => item.id === row.id ? { ...item, ...row } : item));
        },
      )
      .subscribe();
    return () => { void supabase.removeChannel(channel); };
  }, [selectedId, supabase]);

  // Aperçu miniature des photos d'un rapport ouvert, plutôt qu'un simple
  // bouton "Ouvrir" — chargé dès l'ouverture de la fiche rapport.
  useEffect(() => {
    if (!viewingReportDetail) return;
    const reportPhotos = projectPhotos.filter((photo) => photo.report_id === viewingReportDetail.id);
    if (reportPhotos.length) void loadPhotoThumbnails(reportPhotos);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewingReportDetail?.id]);

  useEffect(() => {
    if (unassignedProjectPhotos.length) void loadPhotoThumbnails(unassignedProjectPhotos);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unassignedProjectPhotos.length]);

  useEffect(() => {
    if (!soundEnabled || !projectNotes.length) return;
    const newest = projectNotes[0];
    const lastSeenKey = `btp-project-last-note-${selectedId}`;
    const seen = localStorage.getItem(lastSeenKey);
    if (!seen) { localStorage.setItem(lastSeenKey, newest.id); return; }
    if (seen === newest.id) return;
    localStorage.setItem(lastSeenKey, newest.id);
    if (newest.severity === "urgent" || newest.severity === "review") {
      try {
        const AudioContextClass = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (AudioContextClass) { const context = new AudioContextClass(); const oscillator = context.createOscillator(); const gain = context.createGain(); oscillator.frequency.value = newest.severity === "urgent" ? 880 : 660; gain.gain.setValueAtTime(.07, context.currentTime); gain.gain.exponentialRampToValueAtTime(.001, context.currentTime + .34); oscillator.connect(gain).connect(context.destination); oscillator.start(); oscillator.stop(context.currentTime + .34); }
        navigator.vibrate?.(newest.severity === "urgent" ? [140, 70, 140] : 100);
        if (Notification.permission === "granted") new Notification(newest.severity === "urgent" ? "Remarque urgente" : "Remarque à vérifier", { body: newest.title });
      } catch { /* Le navigateur peut bloquer le son tant qu'il n'a pas reçu d'interaction. */ }
    }
  }, [projectNotes, selectedId, soundEnabled]);

  // Le chantier ne relit plus le DAO tout seul : le planning est copié une
  // bonne fois pour toutes à la création (voir createOrSyncProjectFromEstimate).
  // Le bouton d'import manuel reste disponible pour un chantier déjà lié à un DAO.

  function queueForSync(label: string, action: PendingSync["action"], table: string, payload: Record<string, unknown>, rowId?: string) {
    const key = "btp-project-pending-sync";
    const entry = { id: crypto.randomUUID(), label, action, table, rowId, payload, createdAt: new Date().toISOString() };
    const next = [...pendingSync, entry];
    localStorage.setItem(key, JSON.stringify(next)); setPendingSync(next);
    setMessage(`${label} est conservé sur cet appareil et sera synchronisé à la prochaine connexion.`);
  }

  async function toggleSoundAlerts() {
    const enabled = !soundEnabled;
    setSoundEnabled(enabled);
    localStorage.setItem("btp-project-note-sound", enabled ? "enabled" : "disabled");
    if (enabled && "Notification" in window && Notification.permission === "default") await Notification.requestPermission();
  }

  async function markNotesRead() {
    if (!userId || !unreadNotes.length) return;
    const readAt = new Date().toISOString();
    const targets = unreadNotes;
    const buildUpdates = (note: RecordNote) => {
      const updates: Partial<RecordNote> = {};
      if (noteOriginalUnread(note)) updates.read_by = [...(note.read_by ?? []), { user_id: userId, read_at: readAt }];
      if (noteReplyUnread(note)) updates.reply_read_by = [...(note.reply_read_by ?? []), { user_id: userId, read_at: readAt }];
      return updates;
    };
    setRecordNotes((rows) => rows.map((row) => { const target = targets.find((item) => item.id === row.id); return target ? { ...row, ...buildUpdates(target) } : row; }));
    if (!online) {
      // Plusieurs remarques à la fois : on ajoute toutes les entrées en un
      // seul coup (au lieu d'appeler queueForSync en boucle) pour ne pas en
      // perdre en route à cause des mises à jour d'état groupées par React.
      const entries: PendingSync[] = targets.map((note) => ({ id: crypto.randomUUID(), label: "Lecture de remarque", action: "update", table: "project_record_notes", rowId: note.id, payload: buildUpdates(note), createdAt: new Date().toISOString() }));
      const next = [...pendingSync, ...entries];
      localStorage.setItem("btp-project-pending-sync", JSON.stringify(next));
      setPendingSync(next);
      return;
    }
    await Promise.all(targets.map((note) => supabase.from("project_record_notes").update(buildUpdates(note)).eq("id", note.id)));
  }

  async function markNoteRead(note: RecordNote) {
    if (!userId) return;
    if (!noteOriginalUnread(note) && !noteReplyUnread(note)) return;
    const readAt = new Date().toISOString();
    const updates: Partial<RecordNote> = {};
    if (noteOriginalUnread(note)) updates.read_by = [...(note.read_by ?? []), { user_id: userId, read_at: readAt }];
    if (noteReplyUnread(note)) updates.reply_read_by = [...(note.reply_read_by ?? []), { user_id: userId, read_at: readAt }];
    setRecordNotes((rows) => rows.map((row) => row.id === note.id ? { ...row, ...updates } : row));
    if (!online) { queueForSync("Lecture de remarque", "update", "project_record_notes", updates, note.id); return; }
    await supabase.from("project_record_notes").update(updates).eq("id", note.id);
  }

  async function submitNoteReply(note: RecordNote) {
    if (!replyDraft.content.trim()) { setMessage("Écrivez une réponse avant de valider."); return; }
    const readAt = new Date().toISOString();
    const updates: Partial<RecordNote> = {
      reply_content: replyDraft.content.trim(),
      reply_severity: replyDraft.severity,
      replied_by: userId || null,
      replied_at: readAt,
      reply_read_by: userId ? [{ user_id: userId, read_at: readAt }] : [],
    };
    setRecordNotes((rows) => rows.map((row) => row.id === note.id ? { ...row, ...updates } : row));
    setViewingNoteDetail((current) => current && current.id === note.id ? { ...current, ...updates } : current);
    setReplyDraft({ severity: "review", content: "" });
    if (!online) { queueForSync("Réponse à une remarque", "update", "project_record_notes", updates, note.id); setMessage("Réponse enregistrée hors ligne, envoi dès la reconnexion."); return; }
    const { error } = await supabase.from("project_record_notes").update(updates).eq("id", note.id);
    if (error) setMessage(`Réponse non enregistrée : ${error.message}`); else setMessage("Réponse envoyée à l’équipe.");
  }

  async function analyzeReportPhotos(report: Report) {
    if (!isAdmin || !online || !selectedId) return;
    setAiAnalysisResult(null);
    setAiAnalysisStatus({ kind: "info", text: "Analyse des photos en cours…" });
    try {
      const response = await fetch(`/api/projects/${selectedId}/analyze-report-photos`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ report_id: report.id }) });
      const data = await response.json();
      if (!response.ok) { setAiAnalysisStatus({ kind: "error", text: data.error || "Analyse impossible." }); return; }
      setAiAnalysisResult(data.analysis);
      setAiAnalysisStatus({ kind: "success", text: `Analyse terminée (${data.photosAnalyzed ?? 1} photo(s) examinée(s))${data.photosSkipped ? `, ${data.photosSkipped} ignorée(s) (format illisible)` : ""}.` });
    } catch {
      setAiAnalysisStatus({ kind: "error", text: "Analyse impossible : problème de connexion." });
    }
  }

  async function reportAiAnalysisAsNote() {
    if (!aiAnalysisResult || !viewingReportDetail || !organizationId || !selectedId) return;
    const verdictLabel = aiAnalysisResult.verdict === "coherent" ? "cohérent" : aiAnalysisResult.verdict === "incoherent" ? "incohérence possible" : "incertain";
    const severity = aiAnalysisResult.verdict === "incoherent" ? "urgent" : "review";
    const title = `Analyse IA — rapport du ${date.format(new Date(viewingReportDetail.report_date))}`;
    const content = [
      `Verdict IA : ${verdictLabel} (confiance ${aiAnalysisResult.confidence} %).`,
      aiAnalysisResult.summary,
      ...aiAnalysisResult.observations.map((observation) => `- ${observation}`),
    ].join("\n");
    setAiAnalysisStatus({ kind: "info", text: "Envoi du signalement…" });
    const payload = { organization_id: organizationId, project_id: selectedId, entity_type: "daily_report", entity_id: viewingReportDetail.id, severity, title, content };
    if (!online) {
      queueForSync("Signalement IA", "insert", "project_record_notes", payload);
      setAiAnalysisStatus(null);
      setAiAnalysisResult(null);
      setViewingPhotoUrl(null);
      setViewingReportDetail(null);
      setMessage("Signalement enregistré hors ligne, envoi dès la reconnexion.");
      return;
    }
    const { data, error } = await supabase.from("project_record_notes").insert(payload).select().single();
    if (error) { setAiAnalysisStatus({ kind: "error", text: `Signalement non envoyé : ${error.message}` }); return; }
    setRecordNotes((rows) => [data as RecordNote, ...rows]);
    setAiAnalysisStatus(null);
    setAiAnalysisResult(null);
    setViewingPhotoUrl(null);
    setViewingReportDetail(null);
    setMessage("Analyse IA signalée à l’équipe : visible dans « Remarques et notifications ».");
  }

  // Rejoue un rapport journalier mis de côté hors connexion : relance le même
  // calcul de stock côté serveur, applique les mêmes mises à jour de planning,
  // puis envoie les photos gardées sur l'appareil. Si des photos échouent
  // encore (reconnexion coupée en cours de route), l'entrée est conservée
  // avec seulement les photos restantes, pour réessayer plus tard sans
  // recréer le rapport une deuxième fois.
  async function syncQueuedReport(entry: PendingSync): Promise<{ ok: boolean; entry?: PendingSync }> {
    const queued = entry.payload as unknown as QueuedReportPayload;
    const { data: reportId, error } = await supabase.rpc("record_project_daily_report_consumption", queued.reportInput);
    if (error || !reportId) return { ok: false, entry };

    await Promise.all(queued.taskUpdates.map((item) =>
      supabase.from("project_tasks").update({ progress_percent: item.progress_percent, status: item.status, ...(item.checklist ? { checklist: item.checklist } : {}) }).eq("id", item.task_id)
    ));
    await Promise.all(queued.materialUpdates.map((item) =>
      supabase.from("project_materials").update({ required_tomorrow: item.quantity }).eq("id", item.material_id)
    ));

    const projectId = queued.reportInput.p_project_id;
    const failedPhotoIds: string[] = [];
    for (const photoId of queued.photoIds) {
      const stored = await loadOfflinePhoto(photoId);
      if (!stored) continue; // déjà envoyée lors d'une tentative précédente
      const path = `${organizationId}/${projectId}/site-photos/${crypto.randomUUID()}-${stored.name.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
      const { error: uploadError } = await supabase.storage.from("btp-documents").upload(path, stored.blob, { upsert: false, contentType: stored.type });
      if (uploadError) { failedPhotoIds.push(photoId); continue; }
      const { data: photoRow } = await supabase.from("project_photos").insert({ organization_id: organizationId, project_id: projectId, storage_path: path, report_id: reportId, photo_type: "progress", created_by: userId }).select().single();
      if (photoRow) { setPhotos((rows) => [photoRow as SitePhoto, ...rows]); await deleteOfflinePhoto(photoId); }
      else failedPhotoIds.push(photoId);
    }

    const [reportResult, materialsResult, movementsResult, tasksResult] = await Promise.all([
      supabase.from("project_daily_reports").select("*").eq("id", reportId).single(),
      supabase.from("project_materials").select("*").eq("project_id", projectId),
      supabase.from("project_stock_movements").select("*").eq("project_id", projectId).order("created_at", { ascending: false }),
      supabase.from("project_tasks").select("*").eq("project_id", projectId).order("dao_sequence", { ascending: true }),
    ]);
    // On retire l'ancienne ligne locale ("local-...") par date plutôt que par
    // id, pour ne pas toucher un autre rapport hors ligne pas encore synchronisé.
    if (reportResult.data) { const synced = reportResult.data as Report; setReports((rows) => [synced, ...rows.filter((item) => item.report_date !== synced.report_date)]); }
    if (materialsResult.data) setMaterials((rows) => [...rows.filter((item) => item.project_id !== projectId), ...(materialsResult.data as Material[])]);
    if (movementsResult.data) setStockMovements((rows) => [...rows.filter((item) => item.project_id !== projectId), ...(movementsResult.data as StockMovement[])]);
    if (tasksResult.data) setTasks((rows) => [...rows.filter((item) => item.project_id !== projectId), ...(tasksResult.data as Task[])]);

    if (failedPhotoIds.length) return { ok: false, entry: { ...entry, payload: { ...queued, photoIds: failedPhotoIds } as unknown as Record<string, unknown> } };
    return { ok: true };
  }

  // Rejoue une validation d'achat mise de côté hors connexion, avec sa photo
  // reprise sur l'appareil (voir performPurchaseValidation, utilisée aussi
  // pour la validation en ligne, afin de garder un seul calcul de stock).
  async function syncQueuedPurchase(entry: PendingSync): Promise<{ ok: boolean; entry?: PendingSync }> {
    const queued = entry.payload as unknown as QueuedPurchasePayload;
    const order = materialOrders.find((item) => item.id === queued.orderId);
    // La photo reste facultative même hors ligne : un achat mis de côté sans
    // photo n'a simplement rien à recharger ici. La vérification IA
    // photo/quantité, elle, ne peut se faire que connecté : elle n'a donc
    // jamais lieu pour un achat rejoué depuis la file hors ligne.
    const stored = queued.photoId ? await loadOfflinePhoto(queued.photoId) : null;
    if (!order || (queued.photoId && !stored)) return { ok: false, entry };
    const result = await performPurchaseValidation(order, { purchasedQuantity: queued.purchasedQuantity, unitPrice: queued.unitPrice, photo: stored, transportMode: queued.transportMode, transportPrice: queued.transportPrice, fournisseur: queued.fournisseur || null });
    if (!result.ok) return { ok: false, entry };
    if (queued.photoId) await deleteOfflinePhoto(queued.photoId);
    return { ok: true };
  }

  async function synchronizePending() {
    // navigator.onLine plutôt que l'état React "online" : cette fonction peut
    // être appelée juste après l'événement "online", avant que le nouveau
    // rendu n'ait mis à jour cet état.
    if (!navigator.onLine || !pendingSync.length || !organizationId) return;
    setBusy(true); setMessage("Synchronisation des saisies locales…");
    const remaining: PendingSync[] = [];
    for (const entry of pendingSync) {
      if (entry.action === "report") {
        const result = await syncQueuedReport(entry);
        if (!result.ok && result.entry) remaining.push(result.entry);
        continue;
      }
      if (entry.action === "purchase") {
        const result = await syncQueuedPurchase(entry);
        if (!result.ok && result.entry) remaining.push(result.entry);
        continue;
      }
      const request = entry.action === "insert"
        ? supabase.from(entry.table).insert(entry.payload)
        : supabase.from(entry.table).update(entry.payload).eq("id", entry.rowId || "");
      const { error } = await request;
      if (error) remaining.push(entry);
    }
    localStorage.setItem("btp-project-pending-sync", JSON.stringify(remaining)); setPendingSync(remaining); setBusy(false);
    setMessage(remaining.length ? `${remaining.length} saisie(s) restent à synchroniser.` : "Toutes les saisies locales sont synchronisées.");
  }

  async function insert(table: string, payload: Record<string, unknown>, onSuccess: (row: any) => void) {
    if (!organizationId || !selectedId) return;
    if (table !== "project_record_notes" && !canOperate) {
      setMessage("Cette partie est en lecture seule. Ajoutez une remarque au lieu de modifier une saisie d’un autre utilisateur.");
      return;
    }
    const completePayload = { organization_id: organizationId, project_id: selectedId, ...payload };
    if (!online) {
      const local = { ...completePayload, id: `local-${crypto.randomUUID()}`, created_at: new Date().toISOString() };
      onSuccess(local); queueForSync("Saisie hors ligne", "insert", table, completePayload); return;
    }
    setBusy(true); setMessage("");
    const { data, error } = await supabase.from(table).insert(completePayload).select().single();
    setBusy(false);
    if (error) { setMessage(`Enregistrement impossible : ${error.message}`); return; }
    onSuccess(data); setMessage("Enregistré.");
  }

  async function updateProjectProgress(value: string) {
    if (!project || !isAdmin) { setMessage("L’avancement est calculé automatiquement depuis les rapports et le planning."); return; }
    const progress_percent = Math.max(0, Math.min(100, number(value)));
    const status = progress_percent >= 100 ? "completed" : project.status;
    const changes = { progress_percent, status };
    setProjects((rows) => rows.map((row) => row.id === project.id ? { ...row, ...changes } : row));
    if (!online) { queueForSync("Avancement du chantier", "update", "projects", changes, project.id); return; }
    const { error } = await supabase.from("projects").update(changes).eq("id", project.id);
    if (error) setMessage(`Avancement non enregistré : ${error.message}`);
    else setMessage(progress_percent >= 100 ? "Chantier terminé : les accès conducteur et chef sont désactivés." : "Avancement du chantier enregistré.");
  }

  async function submitMiscExpense() {
    const amount = number(miscExpenseDraft.amount);
    if (!miscExpenseDraft.recipient.trim() || amount <= 0) {
      setMiscExpenseStatus({ kind: "error", text: "Indiquez le nom du bénéficiaire et un montant supérieur à zéro." });
      return;
    }
    await insert("project_material_orders", {
      material_name: "Autre",
      material_key: "autre",
      unit: "U",
      quantity: 1,
      unit_price: amount,
      status: "paid",
      expense_kind: "other",
      recipient_name: miscExpenseDraft.recipient.trim(),
      notes: miscExpenseDraft.note.trim() || null,
      requested_by: userId,
      validated_by: userId,
      paid_at: new Date().toISOString(),
    }, (row) => setMaterialOrders((rows) => [row as MaterialOrder, ...rows]));
    setConfirmingMiscExpense(false);
    setAddingMiscExpense(false);
    setMiscExpenseDraft({ recipient: "", amount: "", note: "" });
    setMiscExpenseStatus({ kind: "success", text: "Dépense imprévue enregistrée dans le compte dépense générale." });
  }

  // Suppressions réservées à l'administrateur : chaque fonction annule aussi
  // proprement que possible l'effet sur le stock avant de retirer la saisie,
  // pour ne jamais laisser un chiffre de stock faux derrière une suppression.
  async function adminDeletePhoto(photo: SitePhoto) {
    if (!isAdmin) return;
    if (!online) { setMessage("Connectez-vous pour supprimer une photo."); return; }
    setBusy(true);
    try {
      // La photo disparaît de la galerie mais la ligne reste en base (avec la
      // date de suppression) pour garder une trace, comme pour les autres
      // suppressions administrateur.
      const deletedAt = new Date().toISOString();
      const { error } = await supabase.from("project_photos").update({ deleted_at: deletedAt }).eq("id", photo.id);
      if (error) { setMessage(`Photo non supprimée : ${error.message}`); return; }
      await supabase.storage.from("btp-documents").remove([photo.storage_path]).catch(() => null);
      setPhotos((rows) => rows.map((row) => row.id === photo.id ? { ...row, deleted_at: deletedAt } : row));
      setViewingPhotoUrl(null);
      setViewingPhotoRecord(null);
      setMessage("Photo supprimée (trace conservée dans l’historique des photos).");
    } finally { setBusy(false); }
  }

  async function adminDeleteReport(report: Report) {
    if (!isAdmin || !selectedId) return;
    if (!online) { setMessage("Connectez-vous pour supprimer un rapport."); return; }
    if (!window.confirm(`Supprimer définitivement le rapport du ${date.format(new Date(report.report_date))} ? Le stock consommé ce jour-là sera restitué automatiquement.`)) return;
    setBusy(true);
    try {
      const { error } = await supabase.rpc("admin_delete_daily_report", { p_report_id: report.id });
      if (error) { setMessage(`Rapport non supprimé : ${error.message}`); return; }
      setReports((rows) => rows.filter((row) => row.id !== report.id));
      setViewingReportDetail(null);
      const [materialsResult, movementsResult, usagesResult, photosResult] = await Promise.all([
        supabase.from("project_materials").select("*").eq("project_id", selectedId),
        supabase.from("project_stock_movements").select("*").eq("project_id", selectedId).order("created_at", { ascending: false }),
        supabase.from("project_report_material_usages").select("*").eq("project_id", selectedId),
        supabase.from("project_photos").select("*").eq("project_id", selectedId).order("captured_at", { ascending: false }),
      ]);
      if (materialsResult.data) setMaterials((rows) => [...rows.filter((item) => item.project_id !== selectedId), ...(materialsResult.data as Material[])]);
      if (movementsResult.data) setStockMovements((rows) => [...rows.filter((item) => item.project_id !== selectedId), ...(movementsResult.data as StockMovement[])]);
      if (usagesResult.data) setReportMaterialUsages((rows) => [...rows.filter((item) => item.project_id !== selectedId), ...(usagesResult.data as ReportMaterialUsage[])]);
      if (photosResult.data) setPhotos((rows) => [...rows.filter((item) => item.project_id !== selectedId), ...(photosResult.data as SitePhoto[])]);
      setMessage("Rapport supprimé : stock et photos mis à jour.");
    } finally { setBusy(false); }
  }

  async function adminDeleteMovement(movement: StockMovement) {
    if (!isAdmin) return;
    if (!online) { setMessage("Connectez-vous pour supprimer un mouvement de stock."); return; }
    if (!window.confirm("Supprimer définitivement ce mouvement de stock ? La quantité correspondante sera restituée au matériau.")) return;
    setBusy(true);
    try {
      const { error } = await supabase.rpc("admin_delete_stock_movement", { p_movement_id: movement.id });
      if (error) { setMessage(`Mouvement non supprimé : ${error.message}`); return; }
      setStockMovements((rows) => rows.filter((row) => row.id !== movement.id));
      if (movement.material_id) {
        const { data } = await supabase.from("project_materials").select("*").eq("id", movement.material_id).maybeSingle();
        if (data) setMaterials((rows) => rows.map((row) => row.id === data.id ? (data as Material) : row));
      }
      setMessage("Mouvement supprimé, stock mis à jour.");
    } finally { setBusy(false); }
  }

  async function adminDeleteMaterialOrder(order: MaterialOrder) {
    if (!isAdmin) return;
    if (!online) { setMessage("Connectez-vous pour supprimer un achat."); return; }
    if (!window.confirm(`Supprimer définitivement cet achat (${order.material_name}) ? Le stock déjà ajouté par cet achat sera retiré.`)) return;
    setBusy(true);
    try {
      const { error } = await supabase.rpc("admin_delete_material_order", { p_order_id: order.id });
      if (error) { setMessage(`Achat non supprimé : ${error.message}`); return; }
      setMaterialOrders((rows) => rows.filter((row) => row.id !== order.id));
      if (order.material_id) {
        const { data } = await supabase.from("project_materials").select("*").eq("id", order.material_id).maybeSingle();
        if (data) setMaterials((rows) => rows.map((row) => row.id === data.id ? (data as Material) : row));
      }
      setMessage("Achat supprimé, stock mis à jour.");
    } finally { setBusy(false); }
  }

  async function adminDeleteStaffMember(member: StaffMember) {
    if (!isAdmin) return;
    if (!online) { setMessage("Connectez-vous pour retirer un membre de l’équipe."); return; }
    setBusy(true);
    try {
      // Retrait "doux" : la personne disparaît de l'équipe active mais la
      // ligne reste en base (avec la date de retrait), pour garder une trace
      // au lieu de perdre l'information — comme pour les paiements de salaire.
      const { error } = await supabase.from("project_staff_members").update({ active: false, deleted_at: new Date().toISOString() }).eq("id", member.id);
      if (error) { setMessage(`Membre non retiré : ${error.message}`); return; }
      setStaffMembers((rows) => rows.map((row) => row.id === member.id ? { ...row, active: false, deleted_at: new Date().toISOString() } : row));
      setRevealedKey(null);
      setMessage("Membre retiré de l’équipe déclarée (visible dans l’historique de l’équipe).");
    } finally { setBusy(false); }
  }

  async function updateStaffSupervisor(member: StaffMember, supervisorAssignmentId: string) {
    if (!isAdmin && accessRole !== "works_manager") return;
    const value = supervisorAssignmentId || null;
    setStaffMembers((rows) => rows.map((row) => row.id === member.id ? { ...row, supervisor_assignment_id: value } : row));
    if (!online) { queueForSync("Affectation d’un membre à un chef", "update", "project_staff_members", { supervisor_assignment_id: value }, member.id); return; }
    const { error } = await supabase.from("project_staff_members").update({ supervisor_assignment_id: value }).eq("id", member.id);
    if (error) setMessage(`Affectation non enregistrée : ${error.message}`);
  }

  // Change le "poste" d'une fiche d'"Équipe déclarée" — pour un ouvrier
  // c'est un simple intitulé libre (maçon, aide…) ; pour un conducteur/chef
  // lié à un accès (linked_assignment_id), ce même champ sert aussi
  // d'étiquette de paye ("Conducteur" ↔ "Conducteur associé", réglable
  // séparément dans Taux de paye), sans toucher à ses droits d'accès réels.
  async function updateStaffRoleName(member: StaffMember, roleName: string) {
    if (!isAdmin && accessRole !== "works_manager") return;
    const trimmed = roleName.trim();
    setEditingRoleStaffId(null);
    if (!trimmed || trimmed === (member.role_name || "")) return;
    setBusy(true);
    try {
      // La promotion ne doit compter qu'à partir d'aujourd'hui : on garde
      // l'historique des postes précédents (jours déjà travaillés, payés au
      // taux d'alors) et on ajoute simplement une nouvelle entrée à partir
      // de maintenant, plutôt que d'écraser le poste en place.
      const newHistory = [...(Array.isArray(member.role_history) ? member.role_history : []), { role_name: trimmed, effective_from: today }];
      const { data, error } = await supabase.from("project_staff_members").update({ role_name: trimmed, role_history: newHistory }).eq("id", member.id).select().single();
      if (error || !data) { setMessage(`Poste non enregistré : ${error?.message ?? "erreur inconnue"}`); return; }
      setStaffMembers((rows) => rows.map((row) => row.id === member.id ? (data as StaffMember) : row));
      setMessage(`Poste mis à jour à partir d’aujourd’hui : "${trimmed}" (les jours déjà travaillés restent payés à l’ancien taux).`);
    } finally { setBusy(false); }
  }

  async function updateTask(id: string, values: Partial<Task>) {
    const task = tasks.find((item) => item.id === id);
    // Les étapes du planning DAO sont partagées par toute l'équipe du chantier
    // (pas une saisie personnelle) : tout niveau opérationnel peut y déclarer
    // son avancement, contrairement aux autres saisies limitées à leur auteur.
    const editable = task && (task.is_dao_task ? canOperate : canEditOwnCurrentRecord(task));
    if (!task || !editable) { setMessage("Cette saisie est en lecture seule. Ajoutez une remarque au lieu de la modifier."); return; }
    setTasks((rows) => rows.map((row) => row.id === id ? { ...row, ...values } : row));
    if (!online) { queueForSync("Mise à jour d’une tâche", "update", "project_tasks", values, id); return; }
    const { error } = await supabase.from("project_tasks").update(values).eq("id", id);
    if (error) setMessage(`Tâche non enregistrée : ${error.message}`);
  }

  async function updateMaterial(id: string, values: Partial<Material>) {
    const material = materials.find((item) => item.id === id);
    // Le stock d'un matériau (quantité, besoin prévu) évolue en continu,
    // contrairement à une saisie personnelle du jour : pas de verrou par date
    // ni par créateur, seule l'autorisation de gérer le stock compte.
    if (!material || !canManageStock) { setMessage("Ce stock est en lecture seule pour votre accès."); return; }
    setMaterials((rows) => rows.map((row) => row.id === id ? { ...row, ...values } : row));
    if (!online) { queueForSync("Mise à jour du stock", "update", "project_materials", values, id); return; }
    const { error } = await supabase.from("project_materials").update(values).eq("id", id);
    if (error) setMessage(`Stock non enregistré : ${error.message}`);
  }

  async function recordStockMovement(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canManageStock) { setMessage("Les mouvements de stock sont en lecture seule pour votre accès. Utilisez une remarque pour signaler une correction."); return; }
    // Conserver le formulaire avant toute opération asynchrone : React peut
    // libérer l'événement synthétique pendant l'attente réseau.
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const materialId = String(form.get("material_id") || ""); const material = materials.find((item) => item.id === materialId);
    const movementType = String(form.get("movement_type") || "delivery"); const quantity = number(form.get("quantity"));
    if (!material || !quantity) { setMessage("Choisissez un matériau et une quantité supérieure à zéro."); return; }
    if (movementType === "consumption" && quantity > number(material.on_site_quantity)) { setMessage(`Stock insuffisant : il reste ${number(material.on_site_quantity)} ${material.unit} de ${material.designation}.`); return; }
    const increase = movementType === "delivery" || movementType === "return" || movementType === "adjustment";
    const nextStock = Math.max(0, number(material.on_site_quantity) + (increase ? quantity : -quantity));
    await updateMaterial(material.id, { on_site_quantity: nextStock });
    await insert("project_stock_movements", { material_id: material.id, movement_type: movementType, quantity, movement_date: form.get("movement_date"), notes: form.get("notes") }, (row) => setStockMovements((rows) => [row, ...rows]));
    formElement.reset();
  }

  function stageTaskProgress(taskId: string, progress_percent: number, status: string) {
    setReportSelectedTasks((rows) => {
      const current = rows.find((item) => item.task_id === taskId);
      return current
        ? rows.map((item) => item.task_id === taskId ? { ...item, progress_percent, status } : item)
        : [...rows, { task_id: taskId, progress_percent, status }];
    });
  }

  function toggleChecklistItem(task: Task, itemId: string) {
    const staged = reportSelectedTasks.find((item) => item.task_id === task.id);
    const baseChecklist = staged?.checklist ?? task.checklist ?? [];
    const updated = baseChecklist.map((item) => item.id === itemId ? { ...item, done: !item.done } : item);
    const doneCount = updated.filter((item) => item.done).length;
    const progress_percent = updated.length ? Math.round((doneCount / updated.length) * 100) : 0;
    const status = progress_percent >= 100 ? "completed" : progress_percent > 0 ? "active" : "planned";
    setReportSelectedTasks((rows) => {
      const current = rows.find((item) => item.task_id === task.id);
      return current
        ? rows.map((item) => item.task_id === task.id ? { ...item, progress_percent, status, checklist: updated } : item)
        : [...rows, { task_id: task.id, progress_percent, status, checklist: updated }];
    });
  }

  function toggleWeatherImpact() {
    const line = "- Travail arrêté à cause de la météo";
    setReportDraft((draft) => {
      const lines = draft.issues.split("\n").filter(Boolean);
      return lines.includes(line) ? { ...draft, issues: lines.filter((existing) => existing !== line).join("\n") } : { ...draft, issues: [...lines, line].join("\n") };
    });
  }

  function toggleTomorrowChecklistItem(task: Task, item: ChecklistItem) {
    const line = `- ${task.title} : ${item.label}`;
    setReportDraft((draft) => {
      const lines = draft.nextDayPlan.split("\n").filter(Boolean);
      return lines.includes(line) ? { ...draft, nextDayPlan: lines.filter((existing) => existing !== line).join("\n") } : { ...draft, nextDayPlan: [...lines, line].join("\n") };
    });
  }

  function toggleTomorrowTask(task: Task) {
    setReportTomorrowTaskIds((rows) => {
      const already = rows.includes(task.id);
      const line = `- ${task.title}`;
      setReportDraft((draft) => {
        const lines = draft.nextDayPlan.split("\n").filter(Boolean);
        if (already) return { ...draft, nextDayPlan: lines.filter((item) => item !== line).join("\n") };
        return lines.includes(line) ? draft : { ...draft, nextDayPlan: [...lines, line].join("\n") };
      });
      return already ? rows.filter((id) => id !== task.id) : [...rows, task.id];
    });
  }

  function confirmMaterialQty(quantity: number) {
    if (!materialQtyTarget) return;
    const material = materialQtyTarget;
    const alreadyPlanned = reportConsumptionDraft.find((item) => item.material_id === material.id)?.quantity || 0;
    const remaining = number(material.on_site_quantity) - alreadyPlanned;
    if (quantity <= 0) { setMaterialQtyStatus({ kind: "error", text: "Indiquez une quantité supérieure à zéro." }); return; }
    if (quantity > remaining) { setMaterialQtyStatus({ kind: "error", text: `Validation impossible : il ne reste que ${remaining} ${material.unit} de ${material.designation} en stock.` }); return; }
    setReportConsumptionDraft((rows) => {
      const current = rows.find((item) => item.material_id === material.id);
      return current ? rows.map((item) => item.material_id === material.id ? { ...item, quantity: item.quantity + quantity } : item) : [...rows, { material_id: material.id, quantity }];
    });
    setMaterialQtyTarget(null);
    setMaterialQtyStatus(null);
    setOpenReportField("materials");
  }

  function confirmTomorrowMaterialQty(quantity: number) {
    if (!tomorrowMaterialQtyTarget) return;
    if (quantity <= 0) { setTomorrowQtyStatus({ kind: "error", text: "Indiquez une quantité supérieure à zéro." }); return; }
    const material = tomorrowMaterialQtyTarget;
    const usedToday = reportConsumptionDraft.find((usage) => usage.material_id === material.id)?.quantity || 0;
    const available = Math.max(0, number(material.on_site_quantity) - usedToday);
    setReportTomorrowMaterials((rows) => {
      const current = rows.find((item) => item.material_id === material.id);
      return current ? rows.map((item) => item.material_id === material.id ? { ...item, quantity } : item) : [...rows, { material_id: material.id, quantity }];
    });
    if (quantity > available) setTomorrowQtyStatus({ kind: "info", text: `Il ne reste que ${available} ${material.unit} disponible(s) pour demain — le manque (${quantity - available} ${material.unit}) sera ajouté en demande d’achat à la confirmation.` });
    setTomorrowMaterialQtyTarget(null);
    setTomorrowQtyStatus(null);
    setOpenReportField("tomorrowMaterials");
  }

  function finishTomorrowMaterials() {
    if (tomorrowMaterialShortfalls.length > 0) { setViewingTomorrowSummary(true); return; }
    setOpenReportField(null);
  }

  async function confirmTomorrowMaterialsSummary() {
    setViewingTomorrowSummary(false);
    setOpenReportField(null);
    for (const row of tomorrowMaterialShortfalls) {
      if (!row.material) continue;
      const key = materialKey(row.material.designation);
      const priceOption = priceLibraryOptions.find((option) => materialKey(option.designation) === key);
      await insertExpense({
        material_id: row.material.id,
        material_name: row.material.designation,
        material_key: key,
        unit: row.material.unit,
        quantity: row.shortfall,
        unit_price: priceOption ? priceLibraryPrice(priceOption) : 0,
        needed_timing: "tomorrow",
        status: "submitted",
        submitted_at: new Date().toISOString(),
        requested_by: userId,
      }, (created) => setMaterialOrders((rows) => [created, ...rows]));
    }
    setMessage(`${tomorrowMaterialShortfalls.length} demande(s) d’achat envoyée(s) pour compléter les matériaux de demain.`);
  }

  function handleReportPhotoSelect(files: FileList | null) {
    if (!files?.length) return;
    const entries = Array.from(files).map((file) => ({ id: crypto.randomUUID(), file, previewUrl: URL.createObjectURL(file) }));
    setReportPhotoDraft((rows) => [...rows, ...entries]);
  }

  function removeReportPhoto(id: string) {
    setReportPhotoDraft((rows) => { const target = rows.find((item) => item.id === id); if (target) URL.revokeObjectURL(target.previewUrl); return rows.filter((item) => item.id !== id); });
  }

  function resetReportDraft() {
    reportPhotoDraft.forEach((item) => URL.revokeObjectURL(item.previewUrl));
    setReportDraft({ date: today, weather: "", completedWork: "", nextDayPlan: "", issues: "" });
    setReportSelectedTasks([]); setReportTomorrowTaskIds([]); setReportTomorrowMaterials([]); setReportPhotoDraft([]); setReportConsumptionDraft([]);
  }

  async function submitDailyReport(): Promise<boolean> {
    if (!canRecordAttendance || !organizationId || !selectedId) { setReportSubmitStatus({ kind: "error", text: "Le rapport journalier est en lecture seule pour votre accès." }); return false; }
    const payload = {
      report_date: reportDraft.date || today,
      weather: reportDraft.weather || null,
      workers_present: todayPresentCount,
      completed_work: reportDraft.completedWork || null,
      next_day_plan: reportDraft.nextDayPlan || null,
      issues: reportDraft.issues || null,
    };
    if (payload.report_date !== today) { setReportSubmitStatus({ kind: "error", text: "Seul le rapport du jour est modifiable. Les jours précédentes restent consultables." }); return false; }
    // Hors connexion : le rapport, le planning, le stock prévu et les photos
    // sont gardés sur l'appareil (les photos via IndexedDB, voir
    // lib/offline-photos.ts) puis envoyés automatiquement dès le retour du
    // réseau, exactement comme les autres saisies de ce chantier.
    if (!online) {
      setReportSubmitting(true);
      setReportSubmitStatus({ kind: "info", text: "Enregistrement hors ligne…" });
      try {
        const photoIds: string[] = [];
        for (const photo of reportPhotoDraft) {
          const photoId = crypto.randomUUID();
          await saveOfflinePhoto(photoId, photo.file);
          photoIds.push(photoId);
        }
        const queued: QueuedReportPayload = {
          reportInput: {
            p_project_id: selectedId,
            p_report_date: payload.report_date,
            p_weather: payload.weather,
            p_workers_present: payload.workers_present,
            p_completed_work: payload.completed_work,
            p_next_day_plan: payload.next_day_plan,
            p_issues: payload.issues,
            p_consumptions: reportConsumptionDraft,
          },
          taskUpdates: reportSelectedTasks,
          materialUpdates: reportTomorrowMaterials,
          photoIds,
        };
        queueForSync(`Rapport du ${date.format(new Date(payload.report_date))}`, "report", "project_daily_reports", queued as unknown as Record<string, unknown>);
        const localReport = { id: `local-${crypto.randomUUID()}`, project_id: selectedId, report_date: payload.report_date, weather: payload.weather, workers_present: payload.workers_present, completed_work: payload.completed_work, next_day_plan: payload.next_day_plan, issues: payload.issues, created_by: userId ?? null, created_at: new Date().toISOString() } as Report;
        setReports((rows) => [localReport, ...rows.filter((row) => row.report_date !== payload.report_date)]);
        // Affiche tout de suite l'avancement et les besoins de demain saisis :
        // le stock (déduction des matériaux consommés) sera lui recalculé côté
        // serveur à l'envoi, pour rester fiable.
        setTasks((rows) => rows.map((row) => {
          const staged = reportSelectedTasks.find((item) => item.task_id === row.id);
          return staged ? { ...row, progress_percent: staged.progress_percent, status: staged.status, ...(staged.checklist ? { checklist: staged.checklist } : {}) } : row;
        }));
        setMaterials((rows) => rows.map((row) => {
          const staged = reportTomorrowMaterials.find((item) => item.material_id === row.id);
          return staged ? { ...row, required_tomorrow: staged.quantity } : row;
        }));
        setReportSubmitting(false);
        resetReportDraft();
        setReportSubmitStatus({ kind: "success", text: `Rapport conservé sur cet appareil${photoIds.length ? ` avec ${photoIds.length} photo(s)` : ""} : il sera envoyé et le stock mis à jour automatiquement dès la reconnexion.` });
        return true;
      } catch {
        setReportSubmitting(false);
        setReportSubmitStatus({ kind: "error", text: "Impossible d'enregistrer le rapport hors ligne sur cet appareil (mémoire de stockage pleine ?)." });
        return false;
      }
    }
    setReportSubmitting(true);
    setReportSubmitStatus({ kind: "info", text: "Enregistrement du rapport en cours…" });
    const { data: reportId, error } = await supabase.rpc("record_project_daily_report_consumption", {
      p_project_id: selectedId,
      p_report_date: payload.report_date,
      p_weather: payload.weather,
      p_workers_present: payload.workers_present,
      p_completed_work: payload.completed_work,
      p_next_day_plan: payload.next_day_plan,
      p_issues: payload.issues,
      p_consumptions: reportConsumptionDraft,
    });
    if (error || !reportId) { setReportSubmitting(false); setReportSubmitStatus({ kind: "error", text: `Rapport non enregistré : ${error?.message || "réponse invalide"}` }); return false; }
    await Promise.all(reportSelectedTasks.map((item) => updateTask(item.task_id, { progress_percent: item.progress_percent, status: item.status, ...(item.checklist ? { checklist: item.checklist } : {}) })));
    await Promise.all(reportTomorrowMaterials.map((item) => updateMaterial(item.material_id, { required_tomorrow: item.quantity })));
    let photoFailures = 0;
    for (const photo of reportPhotoDraft) {
      const path = `${organizationId}/${selectedId}/site-photos/${crypto.randomUUID()}-${photo.file.name.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
      const { error: uploadError } = await supabase.storage.from("btp-documents").upload(path, photo.file, { upsert: false, contentType: photo.file.type });
      if (!uploadError) {
        const { data: photoRow } = await supabase.from("project_photos").insert({ organization_id: organizationId, project_id: selectedId, storage_path: path, report_id: reportId, photo_type: "progress", created_by: userId }).select().single();
        if (photoRow) setPhotos((rows) => [photoRow as SitePhoto, ...rows]); else photoFailures += 1;
      } else photoFailures += 1;
    }
    const [reportResult, materialsResult, usagesResult, movementsResult, tasksResult] = await Promise.all([
      supabase.from("project_daily_reports").select("*").eq("id", reportId).single(),
      supabase.from("project_materials").select("*").eq("project_id", selectedId),
      supabase.from("project_report_material_usages").select("*").eq("project_id", selectedId),
      supabase.from("project_stock_movements").select("*").eq("project_id", selectedId).order("created_at", { ascending: false }),
      supabase.from("project_tasks").select("*").eq("project_id", selectedId).order("dao_sequence", { ascending: true }),
    ]);
    setReportSubmitting(false);
    if (reportResult.data) setReports((rows) => [reportResult.data as Report, ...rows.filter((item) => item.id !== reportResult.data?.id)]);
    if (materialsResult.data) setMaterials((rows) => [...rows.filter((item) => item.project_id !== selectedId), ...(materialsResult.data as Material[])]);
    if (usagesResult.data) setReportMaterialUsages((rows) => [...rows.filter((item) => item.project_id !== selectedId), ...(usagesResult.data as ReportMaterialUsage[])]);
    if (movementsResult.data) setStockMovements((rows) => [...rows.filter((item) => item.project_id !== selectedId), ...(movementsResult.data as StockMovement[])]);
    if (tasksResult.data) setTasks((rows) => [...rows.filter((item) => item.project_id !== selectedId), ...(tasksResult.data as Task[])]);
    resetReportDraft();
    setReportSubmitStatus({ kind: photoFailures ? "error" : "success", text: photoFailures ? `Rapport enregistré, mais ${photoFailures} photo(s) n’ont pas pu être envoyées.` : "Rapport enregistré : planning, stock et photos mis à jour automatiquement." });
    return photoFailures === 0;
  }

  async function insertExpense(payload: Record<string, unknown>, onSuccess: (row: MaterialOrder) => void) {
    if (!organizationId || !selectedId || !canManageExpenses) { setMessage("Les dépenses sont réservées à l’administrateur et au conducteur autorisé."); return; }
    const completePayload = { organization_id: organizationId, project_id: selectedId, ...payload };
    if (!online) {
      const local = { ...completePayload, id: `local-${crypto.randomUUID()}`, created_at: new Date().toISOString() } as unknown as MaterialOrder;
      onSuccess(local); queueForSync("Demande de matériau", "insert", "project_material_orders", completePayload); return;
    }
    setBusy(true);
    const { data, error } = await supabase.from("project_material_orders").insert(completePayload).select().single();
    setBusy(false);
    if (error) { setMessage(`Demande non enregistrée : ${error.message}`); return; }
    onSuccess(data as MaterialOrder); setMessage("Demande de matériau enregistrée.");
  }

  async function submitMaterialRequest() {
    if (!canManageExpenses || !organizationId || !selectedId || busy) return;
    const { material, quantity: quantityText, timing } = requestDraft;
    const quantity = number(quantityText);
    if (!material) { setRequestStatus({ kind: "error", text: "Choisissez un matériau." }); return; }
    if (quantity <= 0) { setRequestStatus({ kind: "error", text: "Indiquez une quantité supérieure à zéro." }); return; }
    if (!timing) { setRequestStatus({ kind: "error", text: "Choisissez à quand correspond le besoin." }); return; }
    setBusy(true);
    try {
    const materialName = material.designation;
    const unit = material.unite || "U";
    const unitPrice = priceLibraryPrice(material);
    const key = materialKey(materialName);
    // Le stock du chantier n'est créé qu'à l'achat réel (voir
    // uploadPurchaseEvidence) : une simple demande ne doit jamais faire
    // apparaître le matériau dans « Matériaux et stock » avant cela.
    const matching = projectMaterials.find((item) => materialKey(item.designation) === key);
    setRequestStatus({ kind: "info", text: "Envoi de la demande…" });
    await insertExpense({
      material_id: matching?.id || null,
      material_name: materialName,
      material_key: key,
      unit,
      quantity,
      unit_price: unitPrice,
      needed_timing: timing,
      status: "submitted",
      submitted_at: new Date().toISOString(),
      requested_by: userId,
    }, (row) => setMaterialOrders((rows) => [row, ...rows]));
    setRequestStatus({ kind: "success", text: "Demande envoyée à l’administrateur." });
    setRequestDraft({ material: null, quantity: "", timing: "" });
    setRequestMaterialSearch("");
    } finally { setBusy(false); }
  }

  async function addMaterialToLibrary() {
    if (!organizationId || !canManageExpenses) return;
    const { designation, unite, fournisseur, ville, prix } = newLibraryMaterial;
    const price = number(prix);
    if (!designation.trim()) { setNewLibraryStatus({ kind: "error", text: "Indiquez le nom commercial du matériau." }); return; }
    if (price <= 0) { setNewLibraryStatus({ kind: "error", text: "Indiquez un prix supérieur à zéro." }); return; }
    setNewLibraryStatus({ kind: "info", text: "Ajout en cours…" });
    const now = new Date().toISOString();
    const newOffer: PriceOfferEntry = { fournisseur: fournisseur.trim() || "", ville: ville.trim() || "", region: "", prix: price, disponibilite: "", livraison: "", date_prix: now };
    // Ce matériau existe peut-être déjà (même dans une autre région) : au lieu
    // de créer un doublon (refusé par la base de toute façon), on ajoute cette
    // offre à la fiche existante.
    const targetKey = designationNormKey(designation);
    const existing = priceLibraryOptions.find((option) => designationNormKey(option.designation) === targetKey) || null;
    if (existing) {
      const { merged, cheapest } = mergeOffer(existing.fournisseurs, newOffer);
      const { error } = await supabase.from("price_library").update({
        fournisseurs: merged,
        prix_retenu: cheapest.prix, prix_actuel: cheapest.prix, prix_entreprise: cheapest.prix,
        fournisseur: cheapest.fournisseur || null, ville: cheapest.ville || null, region: cheapest.region || null,
      }).eq("id", existing.id);
      if (error) { setNewLibraryStatus({ kind: "error", text: `Ajout impossible : ${error.message}` }); return; }
      setNewLibraryStatus({ kind: "success", text: "Ce matériau existait déjà : cette offre a été ajoutée à sa fiche." });
    } else {
      const { error } = await supabase.from("price_library").insert({
        organization_id: organizationId,
        designation: designation.trim(),
        unite: unite.trim() || "U",
        fournisseur: fournisseur.trim() || null,
        ville: ville.trim() || null,
        prix_retenu: price,
        prix_entreprise: price,
        statut_prix: "entreprise",
        origine_prix: "manuel",
        fournisseurs: [newOffer],
      });
      if (error) { setNewLibraryStatus({ kind: "error", text: `Ajout impossible : ${error.message}` }); return; }
      setNewLibraryStatus({ kind: "success", text: "Matériau ajouté à la bibliothèque." });
    }
    setNewLibraryMaterial({ designation: "", unite: "U", fournisseur: "", ville: "", prix: "" });
    void refreshPriceLibrary();
  }

  function startLongPress(option: PriceLibraryOption) {
    longPressFiredRef.current = false;
    longPressTimer.current = window.setTimeout(() => {
      longPressFiredRef.current = true;
      setEditingLibraryMaterial(option);
      setEditingLibraryPrice(String(priceLibraryPrice(option) || ""));
      setEditingLibraryVille(option.ville || "");
      setEditingLibraryStatus(null);
    }, 550);
  }
  function cancelLongPress() {
    if (longPressTimer.current) { window.clearTimeout(longPressTimer.current); longPressTimer.current = null; }
  }
  function handleRequestMaterialClick(option: PriceLibraryOption) {
    if (longPressFiredRef.current) { longPressFiredRef.current = false; return; }
    setRequestDraft((draft) => ({ ...draft, material: option }));
    setOpenRequestField(null);
  }

  async function saveLibraryMaterialEdit() {
    if (!editingLibraryMaterial || !organizationId) return;
    const price = number(editingLibraryPrice);
    if (price <= 0) { setEditingLibraryStatus({ kind: "error", text: "Indiquez un prix supérieur à zéro." }); return; }
    const newVille = editingLibraryVille.trim();
    const originalVille = (editingLibraryMaterial.ville || "").trim();
    setEditingLibraryStatus({ kind: "info", text: "Enregistrement…" });
    // Une localisation différente correspond à un autre fournisseur/prix réel,
    // mais reste le MÊME matériau : on ajoute (ou on met à jour) cette offre
    // dans sa liste "fournisseurs" au lieu de créer une nouvelle fiche — ça
    // évite les doublons (ex: 5 fiches "Fer D6", une par région).
    const now = new Date().toISOString();
    const newOffer: PriceOfferEntry = { fournisseur: editingLibraryMaterial.fournisseur || "", ville: newVille || originalVille, region: "", prix: price, disponibilite: "", livraison: "", date_prix: now };
    const { merged, cheapest } = mergeOffer(editingLibraryMaterial.fournisseurs, newOffer);
    const { error } = await supabase.from("price_library").update({
      fournisseurs: merged,
      prix_retenu: cheapest.prix, prix_actuel: cheapest.prix, prix_entreprise: cheapest.prix,
      fournisseur: cheapest.fournisseur || null, ville: cheapest.ville || null, region: cheapest.region || null,
    }).eq("id", editingLibraryMaterial.id);
    if (error) { setEditingLibraryStatus({ kind: "error", text: `Erreur : ${error.message}` }); return; }
    setEditingLibraryStatus({
      kind: "success",
      text: newVille && newVille.toLowerCase() !== originalVille.toLowerCase()
        ? "Cette localisation a été ajoutée aux offres de ce matériau."
        : "Prix mis à jour.",
    });
    void refreshPriceLibrary();
  }

  async function markOrderSeen(order: MaterialOrder) {
    if (!isAdmin || order.seen_at) return;
    const seenAt = new Date().toISOString();
    setMaterialOrders((rows) => rows.map((row) => row.id === order.id ? { ...row, seen_at: seenAt } : row));
    await supabase.from("project_material_orders").update({ seen_at: seenAt }).eq("id", order.id);
  }

  async function updateMaterialOrder(order: MaterialOrder, values: Partial<MaterialOrder>) {
    const editable = canManageExpenses && !isLocked(order.created_at) && (isAdmin || order.requested_by === userId || !order.requested_by);
    if (!editable) { setMessage("Cette demande est verrouillée ou appartient à une autre saisie. Ajoutez plutôt une remarque."); return; }
    setMaterialOrders((rows) => rows.map((row) => row.id === order.id ? { ...row, ...values } : row));
    if (!online) { queueForSync("Mise à jour d’une demande", "update", "project_material_orders", values, order.id); return; }
    const { error } = await supabase.from("project_material_orders").update(values).eq("id", order.id);
    if (error) setMessage(`Demande non enregistrée : ${error.message}`);
  }

  async function approveMaterialRequest(order: MaterialOrder) {
    if (!isAdmin) { setMessage("Seul l’administrateur peut valider une demande d’achat."); return; }
    const material = projectMaterials.find((item) => item.id === order.material_id || materialKey(item.designation) === (order.material_key || materialKey(order.material_name)));
    const available = number(material?.on_site_quantity);
    const requested = number(order.quantity);
    const toPurchase = Math.max(0, requested - available);
    await updateMaterialOrder(order, { status: toPurchase > 0 ? "approved" : "covered_by_stock", approved_at: new Date().toISOString(), approved_quantity: requested, stock_available_at_approval: available, quantity_to_purchase: toPurchase, validated_by: userId || null });
    setMessage(toPurchase > 0 ? `Demande validée : ${available} ${order.unit} en stock, ${toPurchase} ${order.unit} à acheter.` : "Demande couverte entièrement par le stock disponible.");
  }

  async function rejectMaterialRequest(order: MaterialOrder) {
    if (!isAdmin) { setMessage("Seul l’administrateur peut rejeter une demande d’achat."); return; }
    await updateMaterialOrder(order, { status: "rejected", approved_at: new Date().toISOString(), validated_by: userId || null });
    setMessage(`Demande rejetée : ${order.material_name}.`);
  }

  // Cœur de la validation d'un achat (photo, dépense, stock, transport) :
  // utilisé à la fois en ligne (tout de suite) et hors ligne (rejoué plus
  // tard avec la photo gardée sur l'appareil), pour ne jamais avoir deux
  // versions différentes de ce calcul sensible (stock, dépenses).
  async function performPurchaseValidation(order: MaterialOrder, input: { purchasedQuantity: number; unitPrice: number; photo: { blob: Blob; name: string; type: string } | null; transportMode: string | null; transportPrice: number | null; fournisseur?: string | null }): Promise<{ ok: boolean; message: string }> {
    if (!organizationId || !selectedId) return { ok: false, message: "Chantier introuvable." };
    // La liste affichée peut être périmée (onglet resté ouvert, ou longue
    // absence de réseau) : on revérifie l'état réel de la commande avant de
    // créer quoi que ce soit, pour éviter de dupliquer un achat déjà traité
    // ailleurs.
    const { data: freshOrder } = await supabase.from("project_material_orders").select("*").eq("id", order.id).maybeSingle();
    if (!freshOrder || (freshOrder.status !== "approved" && freshOrder.status !== "covered_by_stock")) {
      setMaterialOrders((rows) => rows.filter((row) => row.id !== order.id));
      return { ok: false, message: "Cette demande a déjà été traitée par quelqu’un d’autre. La liste va se rafraîchir." };
    }
    const currentOrder = freshOrder as MaterialOrder;
    // La photo est conseillée mais plus obligatoire (voir uploadPurchaseEvidence,
    // qui prévient et fait confirmer l'utilisateur avant d'arriver ici sans
    // photo) : sans photo, rien n'est archivé et purchase_photo_path reste vide.
    // NOTE PROJET : la contrainte base de données project_material_orders_paid_requires_photo
    // doit être supprimée (voir le message donné dans le chat) pour que cet
    // enregistrement sans photo soit accepté.
    let path: string | null = null;
    let caption = `Achat — ${currentOrder.material_name} · ${input.purchasedQuantity} ${currentOrder.unit} · ${input.unitPrice.toLocaleString("fr-FR")} Ar${input.fournisseur ? ` · ${input.fournisseur}` : ""}`;
    if (input.photo) {
      const safeName = input.photo.name.replace(/[^a-zA-Z0-9._-]/g, "-");
      path = `${organizationId}/${selectedId}/purchase-archives/${currentOrder.id}-${Date.now()}-${safeName}`;
      const { error: uploadError } = await supabase.storage.from("btp-documents").upload(path, input.photo.blob, { upsert: false, contentType: input.photo.type || "image/jpeg" });
      if (uploadError) return { ok: false, message: `Photo non envoyée : ${uploadError.message}` };
      const { data: photo, error: photoError } = await supabase.from("project_photos").insert({ organization_id: organizationId, project_id: selectedId, storage_path: path, caption, photo_type: "delivery", created_by: userId }).select().single();
      if (photoError) return { ok: false, message: `Archive photo non enregistrée : ${photoError.message}` };
      setPhotos((rows) => [photo as SitePhoto, ...rows]);
    } else {
      caption = `${caption} · sans photo`;
    }
    const values = { status: "paid", paid_at: new Date().toISOString(), validated_by: userId || null, purchased_quantity: input.purchasedQuantity, unit_price: input.unitPrice, purchase_photo_path: path, purchase_photo_caption: caption };
    // .select() + vérification de la ligne retournée : une mise à jour bloquée
    // par une politique RLS ne remonte aucune erreur (0 ligne modifiée, succès
    // silencieux), ce qui donnait l'impression que l'achat était validé alors
    // que rien n'était réellement enregistré.
    const { data: updatedOrder, error } = await supabase.from("project_material_orders").update(values).eq("id", currentOrder.id).select().maybeSingle();
    if (error || !updatedOrder) return { ok: false, message: `Achat non validé : ${error?.message || "vous n'êtes pas autorisé à modifier cette demande."}` };
    setMaterialOrders((rows) => rows.map((row) => row.id === currentOrder.id ? { ...row, ...values } : row));
    let transportWarning = "";
    if (input.transportMode) {
      const { data: transportOrder, error: transportError } = await supabase.from("project_material_orders").insert({
        organization_id: organizationId, project_id: selectedId, material_name: "Transport", material_key: "transport", unit: "U",
        quantity: 1, unit_price: input.transportPrice || 0, status: "paid", expense_kind: "transport", transport_mode: input.transportMode,
        paid_at: new Date().toISOString(), requested_by: userId, validated_by: userId,
        // Le transport n'a pas sa propre photo — il réutilise celle de l'achat
        // du matériau si elle existe (même field déjà présent).
        purchase_photo_path: path, purchase_photo_caption: caption,
      }).select().single();
      if (transportOrder) setMaterialOrders((rows) => [transportOrder as MaterialOrder, ...rows]);
      else if (transportError) transportWarning = ` Transport non enregistré : ${transportError.message}.`;
    }
    // Le matériau n'entre dans le suivi de stock qu'ici, au premier achat
    // réel — jamais dès la simple demande.
    let stockMaterialId = currentOrder.material_id;
    if (!stockMaterialId) {
      const key = currentOrder.material_key || materialKey(currentOrder.material_name);
      // On relit la liste en base (et non le state React, potentiellement
      // périmé si un autre poste a acheté ce même matériau entre-temps)
      // pour éviter de créer un doublon du même matériau.
      const { data: freshMaterials } = await supabase.from("project_materials").select("id,designation").eq("project_id", selectedId);
      const existing = (freshMaterials || []).find((item) => materialKey(item.designation) === key);
      if (existing) {
        stockMaterialId = existing.id;
      } else {
        const { data: newMaterial, error: newMaterialError } = await supabase.from("project_materials").insert({ organization_id: organizationId, project_id: selectedId, designation: currentOrder.material_name, unit: currentOrder.unit, planned_quantity: 0, on_site_quantity: 0, required_tomorrow: 0, required_week: 0, minimum_stock: 0, created_by: userId }).select().single();
        if (!newMaterialError && newMaterial) { stockMaterialId = newMaterial.id; setMaterials((rows) => [...rows, newMaterial as Material]); }
        else if (newMaterialError) return { ok: false, message: `Achat validé mais stock non initialisé : ${newMaterialError.message}` };
      }
      if (stockMaterialId) await supabase.from("project_material_orders").update({ material_id: stockMaterialId }).eq("id", currentOrder.id);
    }
    if (stockMaterialId) {
      // On relit toujours la quantité en base (pas le state React, qui peut
      // dater d'avant une longue coupure réseau) pour rester exact.
      const { data: currentMaterial } = await supabase.from("project_materials").select("on_site_quantity").eq("id", stockMaterialId).maybeSingle();
      const nextStock = number(currentMaterial?.on_site_quantity) + input.purchasedQuantity;
      const { data: updatedMaterial, error: stockError } = await supabase.from("project_materials").update({ on_site_quantity: nextStock }).eq("id", stockMaterialId).select().maybeSingle();
      if (stockError || !updatedMaterial) return { ok: false, message: `Achat validé mais stock non mis à jour : ${stockError?.message || "vous n'êtes pas autorisé à modifier ce matériau."}` };
      setMaterials((rows) => rows.map((item) => item.id === stockMaterialId ? { ...item, on_site_quantity: nextStock } : item));
      const { data: movementRow, error: movementError } = await supabase.from("project_stock_movements").insert({ organization_id: organizationId, project_id: selectedId, material_id: stockMaterialId, movement_type: "delivery", quantity: input.purchasedQuantity, notes: `Achat validé — ${currentOrder.material_name}`, created_by: userId, source_order_id: currentOrder.id }).select().single();
      if (movementRow) setStockMovements((rows) => [movementRow as StockMovement, ...rows]);
      else if (movementError) return { ok: false, message: `Achat validé mais mouvement de stock non enregistré : ${movementError.message}` };
    }
    return { ok: true, message: `Achat validé, photo archivée et dépense comptabilisée.${transportWarning}` };
  }

  // Vérifie la photo prise au moment de l'achat (matériau visible + nombre
  // d'unités) auprès de l'IA. Ne bloque JAMAIS elle-même : une panne
  // technique (pas de crédit, moteur IA indisponible, erreur réseau) revient
  // avec verificationAvailable=false, à traiter exactement comme une photo
  // qu'on n'a pas pu vérifier — jamais comme une preuve d'incohérence.
  async function verifyPurchasePhoto(file: File, materialName: string, unit: string, declaredQuantity: number): Promise<{
    verificationAvailable: boolean;
    materialMatch: "conforme" | "non_conforme" | "indetermine";
    estimatedQuantity: number | null;
    quantityMatch: "conforme" | "non_conforme" | "indetermine";
    notes: string;
    error: string;
  }> {
    try {
      const body = new FormData();
      body.set("photo", file);
      body.set("material_name", materialName);
      body.set("unit", unit);
      body.set("declared_quantity", String(declaredQuantity));
      const response = await fetch(`/api/projects/${selectedId}/verify-purchase-photo`, { method: "POST", body });
      const payload = await response.json().catch(() => ({}) as { error?: string });
      if (!response.ok) return { verificationAvailable: false, materialMatch: "indetermine", estimatedQuantity: null, quantityMatch: "indetermine", notes: "", error: payload.error || "Vérification automatique indisponible." };
      return { verificationAvailable: true, materialMatch: payload.material_match, estimatedQuantity: payload.estimated_quantity, quantityMatch: payload.quantity_match, notes: payload.notes || "", error: "" };
    } catch {
      return { verificationAvailable: false, materialMatch: "indetermine", estimatedQuantity: null, quantityMatch: "indetermine", notes: "", error: "Vérification automatique indisponible (connexion au moteur IA impossible)." };
    }
  }

  async function uploadPurchaseEvidence(event: FormEvent<HTMLFormElement>, order: MaterialOrder): Promise<boolean> {
    event.preventDefault();
    if (!canUploadPurchaseEvidence || !organizationId || !selectedId) { setPurchaseStatus({ kind: "error", text: "La validation d’achat nécessite l’autorisation Photos." }); return false; }
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const file = form.get("purchase_photo");
    const purchasedQuantity = number(form.get("purchased_quantity")) || number(order.quantity_to_purchase);
    const unitPrice = number(form.get("unit_price"));
    const hasPhoto = file instanceof File && file.size > 0;
    // La photo est conseillée mais plus obligatoire : sans elle, on prévient
    // clairement puis on laisse la personne décider de valider quand même.
    if (!hasPhoto && !window.confirm("Aucune photo n’a été ajoutée pour cet achat. La photo est conseillée (elle permet de vérifier automatiquement le matériau et la quantité). Valider quand même sans photo ?")) {
      setPurchaseStatus({ kind: "error", text: "Ajoutez une photo, ou confirmez la validation sans photo." });
      return false;
    }
    if (purchasedQuantity <= 0) { setPurchaseStatus({ kind: "error", text: "Indiquez une quantité achetée supérieure à zéro." }); return false; }
    // Hors connexion : la photo est gardée sur l'appareil (IndexedDB) et
    // l'achat est mis en attente, exactement comme le rapport journalier —
    // il sera validé pour de vrai (stock inclus) dès la reconnexion. La
    // vérification IA photo/quantité n'a lieu qu'en ligne (voir
    // performPurchaseValidation) : hors connexion, elle est simplement sautée.
    if (!online) {
      setBusy(true);
      try {
        const photoId = hasPhoto ? crypto.randomUUID() : undefined;
        if (hasPhoto && photoId) await saveOfflinePhoto(photoId, file as File);
        const queued: QueuedPurchasePayload = { orderId: order.id, purchasedQuantity, unitPrice, photoId, transportMode: selectedTransportMode, transportPrice: selectedTransportPrice, fournisseur: effectiveOffer?.fournisseur || null };
        queueForSync(`Validation d’achat — ${order.material_name}`, "purchase", "project_material_orders", queued as unknown as Record<string, unknown>);
        setMaterialOrders((rows) => rows.map((row) => row.id === order.id ? { ...row, status: "paid", paid_at: new Date().toISOString(), validated_by: userId || null, purchased_quantity: purchasedQuantity, unit_price: unitPrice } : row));
        setSelectedTransportMode(null); setSelectedTransportPrice(null); setTransportPriceDraft(""); setSelectedPurchaseOffer(null);
        setPurchaseStatus({ kind: "success", text: hasPhoto ? "Achat enregistré hors ligne avec sa photo : il sera validé et le stock mis à jour automatiquement dès la reconnexion." : "Achat enregistré hors ligne sans photo : il sera validé et le stock mis à jour automatiquement dès la reconnexion." });
        formElement.reset();
        return true;
      } catch {
        setPurchaseStatus({ kind: "error", text: "Impossible d’enregistrer l’achat hors ligne sur cet appareil (mémoire de stockage pleine ?)." });
        return false;
      } finally { setBusy(false); }
    }
    setBusy(true);
    setPurchaseStatus({ kind: "info", text: "Vérification de la demande…" });
    try {
      // Vérification IA de la photo AVANT tout enregistrement : un vrai écart
      // détecté (mauvais matériau ou quantité manifestement fausse) bloque la
      // validation pour ne pas fausser le stock du chantier. Une vérification
      // simplement indisponible (panne IA, plus de crédit, photo illisible)
      // ne bloque JAMAIS — elle est traitée comme l'absence de photo.
      let verificationNote = "";
      if (hasPhoto) {
        setPurchaseStatus({ kind: "info", text: "Vérification de la photo par l’IA…" });
        const verification = await verifyPurchasePhoto(file as File, order.material_name, order.unit, purchasedQuantity);
        if (verification.verificationAvailable) {
          const { materialMatch, quantityMatch, estimatedQuantity, notes } = verification;
          if (materialMatch === "non_conforme" || quantityMatch === "non_conforme") {
            const seen = estimatedQuantity != null ? `${estimatedQuantity} ${order.unit} estimé(s) sur la photo` : "matériau différent de celui déclaré";
            setPurchaseStatus({ kind: "error", text: `Vérification photo : écart détecté (${seen}, contre ${purchasedQuantity} ${order.unit} déclaré(s)). ${notes} Reprenez une photo plus claire ou corrigez la quantité avant de valider.` });
            return false;
          }
          verificationNote = materialMatch === "conforme" && quantityMatch === "conforme"
            ? " Quantité et matériau conformes à la photo."
            : quantityMatch === "conforme"
              ? " Quantité conforme à la photo (matériau non identifiable automatiquement)."
              : " Comptage automatique impossible depuis cette photo ; achat validé quand même.";
        } else {
          verificationNote = ` Vérification automatique indisponible (${verification.error}) ; achat validé quand même.`;
        }
      }
      setPurchaseStatus({ kind: "info", text: hasPhoto ? "Envoi de la photo et validation…" : "Validation en cours…" });
      const result = await performPurchaseValidation(order, { purchasedQuantity, unitPrice, photo: hasPhoto ? { blob: file as File, name: (file as File).name, type: (file as File).type } : null, transportMode: selectedTransportMode, transportPrice: selectedTransportPrice, fournisseur: effectiveOffer?.fournisseur || null });
      setPurchaseStatus({ kind: result.ok ? "success" : "error", text: result.ok ? `${result.message}${verificationNote}` : result.message });
      if (result.ok) { setSelectedTransportMode(null); setSelectedTransportPrice(null); setTransportPriceDraft(""); setSelectedPurchaseOffer(null); formElement.reset(); }
      return result.ok;
    } finally { setBusy(false); }
  }

  async function addStaffMember(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    if (!canRecordAttendance || !organizationId || !selectedId) { setMessage("Votre accès ne permet pas de préparer la liste de présence."); return; }
    const form = new FormData(formElement); const full_name = String(form.get("full_name") || "").trim();
    if (!full_name) return;
    if (projectStaff.some((item) => materialKey(item.full_name) === materialKey(full_name))) { setMessage("Cette personne est déjà dans la liste du chantier."); return; }
    const mvola = String(form.get("mvola") || "").trim();
    const mvolaEnabled = form.get("mvola_enabled") === "on";
    const callEnabled = form.get("call_enabled") === "on";
    const roleName = String(form.get("role") || "Ouvrier").trim() || "Ouvrier";
    const payload = { organization_id: organizationId, project_id: selectedId, full_name, role_name: roleName, active: true, mvola_number: mvola || null, mvola_enabled: mvola ? mvolaEnabled : false, call_enabled: mvola ? callEnabled : false, role_history: [{ role_name: roleName, effective_from: today }] };
    if (!online) {
      const local = { ...payload, id: `local-${crypto.randomUUID()}`, created_at: new Date().toISOString() } as StaffMember;
      setStaffMembers((rows) => [...rows, local]); queueForSync("Membre de l’équipe", "insert", "project_staff_members", payload); formElement.reset(); return;
    }
    const { data, error } = await supabase.from("project_staff_members").insert(payload).select().single();
    if (error) { setMessage(`Équipe non enregistrée : ${error.message}`); return; }
    setStaffMembers((rows) => [...rows, data as StaffMember]); formElement.reset();
  }

  async function toggleAttendance(member: StaffMember) {
    if (!canRecordAttendance || !organizationId || !selectedId) { setMessage("La présence est consultable pour votre accès."); return; }
    const existing = todayAttendance.find((item) => item.staff_member_id === member.id);
    if (existing && existing.recorded_by && existing.recorded_by !== userId) { setMessage("Cette présence a été saisie par un autre membre de l’équipe : vous pouvez l’annoter, sans la modifier."); return; }
    if (existing) {
      const values = { present: !existing.present };
      setAttendance((rows) => rows.map((row) => row.id === existing.id ? { ...row, ...values } : row));
      if (!online) { queueForSync("Présence", "update", "project_daily_attendance", values, existing.id); return; }
      const { error } = await supabase.from("project_daily_attendance").update(values).eq("id", existing.id);
      if (error) setMessage(`Présence non enregistrée : ${error.message}`);
      return;
    }
    const payload = { organization_id: organizationId, project_id: selectedId, staff_member_id: member.id, report_date: today, present: true };
    if (!online) { setAttendance((rows) => [...rows, { ...payload, id: `local-${crypto.randomUUID()}`, recorded_by: userId, created_at: new Date().toISOString() }]); queueForSync("Présence", "insert", "project_daily_attendance", payload); return; }
    const { data, error } = await supabase.from("project_daily_attendance").insert(payload).select().single();
    if (error) setMessage(`Présence non enregistrée : ${error.message}`); else setAttendance((rows) => [...rows, data as DailyAttendance]);
  }

  async function answerSuggestion(id: string, status: string, userResponse: string) {
    const suggestion = suggestions.find((item) => item.id === id);
    if (!suggestion || !canEditOwnCurrentRecord(suggestion)) { setMessage("Cette recommandation est consultable. Vous pouvez ajouter une remarque si vous n’êtes pas d’accord."); return; }
    setSuggestions((rows) => rows.map((item) => item.id === id ? { ...item, status, user_response: userResponse } : item));
    if (!online) { queueForSync("Réponse à une suggestion", "update", "project_ai_suggestions", { status, user_response: userResponse, responded_at: new Date().toISOString() }, id); return; }
    const { error } = await supabase.from("project_ai_suggestions").update({ status, user_response: userResponse, responded_at: new Date().toISOString() }).eq("id", id);
    if (error) setMessage(`Réponse non enregistrée : ${error.message}`); else setMessage("Décision enregistrée dans l’historique du chantier.");
  }

  async function requestAiReview() {
    if (!canOperate) { setMessage("L’analyse terrain est réservée à l’équipe autorisée du chantier."); return; }
    if (!selectedId || !online) { setMessage("Connectez-vous avant de lancer l’analyse terrain."); return; }
    setBusy(true); setMessage("Analyse en ligne des rapports, stocks et photos du chantier…");
    try {
      const response = await fetch(`/api/projects/${selectedId}/ai-review`, { method: "POST" });
      const result = await response.json().catch(() => ({})) as { error?: string; message?: string; suggestions?: AiSuggestion[]; messages?: RecordNote[] };
      if (!response.ok) { setMessage(result.error || "L’analyse terrain a échoué."); return; }
      if (result.suggestions?.length) setSuggestions((rows) => [...result.suggestions!, ...rows]);
      if (result.messages?.length) setRecordNotes((rows) => [...result.messages!, ...rows]);
      setMessage(result.message || "Analyse terminée et recommandations enregistrées.");
    } finally { setBusy(false); }
  }

  async function loadPhotoThumbnails(photosToLoad: SitePhoto[]) {
    const missing = photosToLoad.filter((photo) => !photoThumbnails[photo.id]);
    if (!missing.length) return;
    const entries = await Promise.all(missing.map(async (photo) => {
      const { data } = await supabase.storage.from("btp-documents").createSignedUrl(photo.storage_path, 60 * 30);
      return [photo.id, data?.signedUrl] as const;
    }));
    setPhotoThumbnails((current) => {
      const next = { ...current };
      for (const [id, url] of entries) if (url) next[id] = url;
      return next;
    });
  }

  async function openPhoto(photo: SitePhoto) {
    // window.open est bloqué par de nombreux navigateurs mobiles (surtout
    // après un await) : on affiche la photo dans une carte de la page
    // plutôt que d'ouvrir une fenêtre séparée.
    setViewingPhotoRecord(photo);
    setViewingPhotoUrl("");
    const { data, error } = await supabase.storage.from("btp-documents").createSignedUrl(photo.storage_path, 60 * 30);
    if (error || !data?.signedUrl) { setViewingPhotoUrl(null); setMessage("Impossible d’ouvrir cette photo."); return; }
    setViewingPhotoUrl(data.signedUrl);
  }

  function photoThumbLabel(photo: SitePhoto) {
    if (photo.photo_type === "delivery" && photo.caption) {
      const match = photo.caption.match(/^Achat\s*—\s*([^·]+)/);
      const material = (match ? match[1] : photo.caption).trim();
      return `${date.format(new Date(photo.captured_at))} · ${material}`;
    }
    return photo.photo_type === "issue" ? "Incident" : photo.photo_type === "delivery" ? "Livraison" : photo.photo_type === "safety" ? "Sécurité" : "Avancement";
  }

  async function importDaoTasks(): Promise<boolean> {
    if (!isAdmin || projectFinished) {
      setMessage(projectFinished
        ? "Le chantier est terminé : le planning est archivé et ne peut plus être modifié."
        : "Seul l’administrateur importe la structure du planning depuis le DAO.");
      return false;
    }
    if (!selectedId || !online) return false;
    setBusy(true); setMessage("Importation des étapes du planning DAO…");
    try {
      const response = await fetch(`/api/projects/${selectedId}/import-dao-tasks`, { method: "POST" });
      const result = await response.json().catch(() => ({})) as { error?: string; tasks?: Task[]; message?: string };
      if (!response.ok) { setMessage(result.error || "Le planning du DAO ne peut pas être importé."); return false; }
      if (result.tasks) setTasks((rows) => [...rows.filter((item) => item.project_id !== selectedId), ...result.tasks!]);
      setMessage(result.message || "Planning DAO importé.");
      return true;
    } finally { setBusy(false); }
  }

  async function generateTaskChecklists(): Promise<void> {
    if (!isAdmin || !selectedId || !online) return;
    setBusy(true); setChecklistStatus({ kind: "info", text: "Génération des sous-tâches en cours…" });
    try {
      const response = await fetch(`/api/projects/${selectedId}/generate-task-checklist`, { method: "POST" });
      const result = await response.json().catch(() => ({})) as { error?: string; tasks?: Task[]; message?: string };
      if (!response.ok) { setChecklistStatus({ kind: "error", text: result.error || `Échec (code ${response.status}).` }); return; }
      if (result.tasks) setTasks((rows) => [...rows.filter((item) => item.project_id !== selectedId), ...result.tasks!]);
      setChecklistStatus({ kind: "success", text: result.message || "Sous-tâches générées." });
    } catch (error) {
      setChecklistStatus({ kind: "error", text: `Connexion impossible : ${error instanceof Error ? error.message : "erreur réseau"}.` });
    } finally { setBusy(false); }
  }

  async function submitAccessInvitation(body: Record<string, unknown>, formElement: HTMLFormElement) {
    setBusy(true);
    setAccessFeedback({ kind: "info", text: body.confirmReplace ? "Réactivation du compte en cours…" : "Création du compte en cours…" });
    try {
      const response = await fetch(`/api/projects/${selectedId}/access-invitations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({})) as { assignment?: Assignment; error?: string; message?: string; conflict?: boolean };
      if (!response.ok) {
        if (result.conflict && !body.confirmReplace) {
          setBusy(false);
          const wantsReplace = window.confirm(`${result.error || "Un compte existe déjà avec cet identifiant."}\n\nVoulez-vous réactiver ce compte avec les nouvelles informations saisies (mot de passe, rôle et permissions) ?`);
          if (wantsReplace) { await submitAccessInvitation({ ...body, confirmReplace: true }, formElement); return; }
          setAccessFeedback({ kind: "error", text: result.error || "Compte non créé." });
          return;
        }
        setAccessFeedback({ kind: "error", text: result.error || "Compte non créé." });
        return;
      }
      if (result.assignment) setAssignments((rows) => [result.assignment!, ...rows.filter((item) => item.id !== result.assignment!.id)]);
      formElement.reset();
      setAccessPermissions({ reports: true, stock: true, photos: true });
      setCreateRole("works_manager");
      setCreateParentAssignmentId("");
      setCreateIsAssociate(false);
      setAccessFeedback({ kind: "success", text: result.message || "Compte créé avec l’identifiant et le mot de passe saisis : transmettez-les à la personne concernée." });
      setTeamView("team");
    } catch {
      setAccessFeedback({ kind: "error", text: "Impossible de créer l’accès pour le moment. Vérifiez votre connexion puis réessayez." });
    } finally { setBusy(false); }
  }

  async function inviteCollaborator(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (projectFinished) { setAccessFeedback({ kind: "error", text: "Le chantier est terminé : aucun nouvel accès ne peut être créé." }); return; }
    if (!canInvite) { setAccessFeedback({ kind: "error", text: "Vous n’êtes pas autorisé à créer un accès chantier." }); return; }
    if (!selectedId) return;
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    const role = String(form.get("role") || "site_manager");
    const email = String(form.get("email") || "").trim().toLowerCase();
    const password = String(form.get("password") || "");
    const phoneNumber = String(form.get("phone_number") || "").trim();
    const mvolaEnabled = form.get("mvola_enabled") === "on";
    const callEnabled = form.get("call_enabled") === "on";
    if (!email) { setAccessFeedback({ kind: "error", text: "Saisissez l’adresse e-mail du collaborateur." }); return; }
    if (password.length < 6) { setAccessFeedback({ kind: "error", text: "Le mot de passe doit contenir au moins 6 caractères." }); return; }
    if (isAdmin && role === "site_manager" && !createParentAssignmentId) { setAccessFeedback({ kind: "error", text: "Choisissez le conducteur sous lequel rattacher ce chef de chantier." }); return; }
    await submitAccessInvitation({ email, password, role, permissions: accessPermissions, phoneNumber: phoneNumber || undefined, mvolaEnabled: phoneNumber ? mvolaEnabled : false, callEnabled: phoneNumber ? callEnabled : false, parentAssignmentId: isAdmin && role === "site_manager" ? createParentAssignmentId : undefined, isAssociate: isAdmin && role === "works_manager" ? createIsAssociate : undefined }, formElement);
  }

  function openInvitationEdit(invitation: Invitation) {
    if (!selectedId || !isAdmin) {
      setAccessFeedback({ kind: "error", text: "Seul l’administrateur peut modifier une demande d’accès." });
      return;
    }
    if (projectFinished) {
      setAccessFeedback({ kind: "error", text: "Le chantier est terminé : les accès ne peuvent plus être modifiés." });
      return;
    }
    setEditingInvitation(invitation);
    setEditingInvitationEmail(invitation.email);
  }

  async function editPendingInvitation(invitation: Invitation, rawEmail: string) {
    const email = rawEmail.trim().toLowerCase();
    if (!email || email === invitation.email.toLowerCase()) { setEditingInvitation(null); return; }
    setBusy(true);
    setAccessFeedback({ kind: "info", text: "Modification de la demande d’accès…" });
    try {
      const response = await fetch(`/api/projects/${selectedId}/access-invitations`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ invitationId: invitation.id, email }),
      });
      const result = await response.json().catch(() => ({})) as { invitation?: Invitation; error?: string; emailSent?: boolean; message?: string };
      if (!response.ok || !result.invitation) {
        setAccessFeedback({ kind: "error", text: result.error || "Impossible de modifier la demande." });
        return;
      }
      setInvitations((rows) => rows.map((item) => item.id === invitation.id ? result.invitation! : item));
      setAccessFeedback({ kind: result.emailSent === false ? "info" : "success", text: result.message || "Adresse e-mail mise à jour." });
      setEditingInvitation(null);
    } catch {
      setAccessFeedback({ kind: "error", text: "Impossible de modifier la demande pour le moment." });
    } finally { setBusy(false); }
  }

  async function revokeAccess(payload: { invitationId?: string; assignmentId?: string }, label: string) {
    if (!selectedId || !isAdmin) {
      setAccessFeedback({ kind: "error", text: "Seul l’administrateur peut retirer un accès." });
      return;
    }
    if (projectFinished) {
      setAccessFeedback({ kind: "error", text: "Le chantier est terminé : les accès sont déjà désactivés." });
      return;
    }
    setBusy(true);
    setAccessFeedback({ kind: "info", text: "Mise à jour de l’accès…" });
    try {
      const response = await fetch(`/api/projects/${selectedId}/access-invitations`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({})) as { error?: string };
      if (!response.ok) {
        setAccessFeedback({ kind: "error", text: result.error || "Impossible de retirer l’accès." });
        return;
      }
      const revokedAt = new Date().toISOString();
      if (payload.invitationId) setInvitations((rows) => rows.filter((item) => item.id !== payload.invitationId));
      if (payload.assignmentId) setAssignments((rows) => rows.map((item) => item.id === payload.assignmentId ? { ...item, active: false, revoked_at: revokedAt } : item));
      setRevealedKey(null);
      setAccessFeedback({ kind: "success", text: `${label} retiré. Les données déjà enregistrées sont conservées.` });
    } catch {
      setAccessFeedback({ kind: "error", text: "Impossible de retirer l’accès pour le moment." });
    } finally { setBusy(false); }
  }

  if (!organizationId) return <div className="notice danger">Aucune entreprise associée au compte.</div>;
  if (!projects.length) return <section className="panel projectEmpty"><h1>Chantiers</h1><p>Le chantier est créé automatiquement après validation d’un devis lié à un DAO.</p></section>;

  // Chantier clôturé : plus aucune modification n'est possible (y compris
  // pour l'administrateur, qui garde seulement la consultation). Pour le
  // conducteur et le chef, la page reste en plus recouverte d'un écran de
  // verrouillage transparent géré par la page qui affiche ce composant —
  // ce blocage-ci s'applique dans tous les cas, en filet de sécurité.
  const locked = Boolean(project?.closed_at);

  return <div className="projectSitePage" style={locked ? { pointerEvents: "none" } : undefined}>
    <header className="projectSiteHeader"><div><p className="projectEyebrow">PILOTAGE OPÉRATIONNEL</p><h1>{projectPage ? (isAdmin ? "Espace chantier" : accessRole === "works_manager" ? "Espace conducteur de travaux" : accessRole === "site_manager" ? "Espace chef de chantier" : "Espace chantier") : "Chantiers"}</h1><p>{isAdmin ? "Consultez les rapports, importez le planning DAO et gérez les accès de l’équipe." : "Saisissez les informations autorisées pour ce chantier."}</p></div><div className="projectHeaderActions">{projectPage && !isSiteManager && <Link className="projectBackLink" href="/projects">← Retour aux chantiers</Link>}{unreadNotes.length > 0 && <button type="button" className="projectNotesBell" onClick={() => { setViewingNotes(true); void markNotesRead(); }} title="Voir les messages non lus">🔔 {unreadNotes.length}</button>}{isAdmin && unseenOrdersForAdmin.length > 0 && <button type="button" className="projectNotesBell" onClick={() => document.getElementById("materialsCard")?.scrollIntoView({ behavior: "smooth", block: "start" })} title="Voir les nouvelles demandes de matériaux">📦 {unseenOrdersForAdmin.length}</button>}<span className={`projectConnection ${online ? "online" : "offline"}`}>{online ? "● Connecté" : "● Hors ligne"}</span><button type="button" className="projectAlertPermission" onClick={() => void toggleSoundAlerts()}>{soundEnabled ? "Alertes sonores actives" : "Activer les alertes"}</button>{pendingSync.length > 0 && <button type="button" onClick={() => void synchronizePending()} disabled={!online || busy}>Synchroniser {pendingSync.length} saisie(s)</button>}{!projectPage && <label>Chantier actif<select value={selectedId} onChange={(event) => setSelectedId(event.target.value)}>{projects.map((item) => <option key={item.id} value={item.id}>{item.project_code ? `${item.project_code} — ` : ""}{item.name}</option>)}</select></label>}</div></header>
    {message && <div className="notice">{message}</div>}
    {project && <>
      <section className="projectHero"><div><p className="projectEyebrow">{project.status === "completed" ? "TERMINÉ" : project.status === "paused" ? "EN PAUSE" : "CHANTIER EN COURS"}</p><h2>{project.name}</h2><p>{project.location || "Localisation à confirmer"}</p><small>Échéance prévue : {project.planned_end_date ? date.format(new Date(project.planned_end_date)) : "à définir"}</small></div><div className="projectProgress"><strong>{averageProgress} %</strong><span>Avancement opérationnel</span><div className="appProgress"><span style={{ width: `${averageProgress}%` }} /></div>{isAdmin ? <label>Avancement global<input type="number" min="0" max="100" value={number(project.progress_percent)} onChange={(event) => void updateProjectProgress(event.target.value)} /></label> : <small>Lecture seule — calculé depuis les rapports et les tâches.</small>}{projectFinished && <p className="projectHint">Chantier clôturé : les accès opérationnels sont désactivés. Les rapports restent archivés et consultables.</p>}{isAdmin && project.closed_at && <p className="projectHint">🔒 Chantier clôturé le {date.format(new Date(project.closed_at))} : les accès conducteur, chef et équipe sont en pause. Réouvrez-le depuis <Link href="/projects">la liste des chantiers</Link> pour tout réactiver.</p>}</div></section>
      <main className="projectSiteGrid">
        {(isAdmin || accessRole === "works_manager" || isSiteManager) && <section className={`projectSiteCard projectAccessCard${isAdmin ? " mobAdminOrder7" : ""}`}>
          <div className="projectCardHead"><div><p className="projectEyebrow">ACCÈS DU CHANTIER</p><h2>{isAdmin ? "Conducteurs et équipe" : isSiteManager ? "Mon équipe" : "Chef de chantier et équipe"}</h2></div><span>{isSiteManager ? projectStaff.length : pendingInvitations.length} {isSiteManager ? "personne(s)" : "création(s) en attente"}</span></div>
          {isSiteManager ? <div className="projectStaffPanel">
            <div className="projectStaffPanelForm">
              <h3>Ajouter un membre</h3>
              {canRecordAttendance ? <form className="projectStaffForm" onSubmit={(event) => void addStaffMember(event)}><input name="full_name" required placeholder="Nom et prénom de l’employé" /><input name="role" placeholder="Poste (maçon, aide, magasinier…)" /><input name="mvola" placeholder="Numéro de téléphone (facultatif)" /><label className="projectInlineCheck"><input type="checkbox" name="mvola_enabled" defaultChecked /> Mvola</label><label className="projectInlineCheck"><input type="checkbox" name="call_enabled" defaultChecked /> Appel</label><button disabled={busy}>+ Ajouter à l’équipe</button></form> : <p className="projectHint">Votre accès ne permet pas d’ajouter des membres.</p>}
            </div>
            <div className="projectStaffPanelList">
              <h3>Équipe déclarée</h3>
              <p>{projectStaff.length} personne(s) active(s)</p>
              {projectStaff.length ? projectStaff.map((member) => <div className="projectTeamMember" key={member.id}><strong>{member.full_name}</strong>{phoneLink(member.mvola_number)}<span>{member.role_name || "Équipe"}</span></div>) : <small>Ajoutez votre équipe : elle sera aussi disponible depuis le rapport journalier.</small>}
            </div>
          </div> : <>
          <p className="projectHint">Créez les accès depuis ce chantier. Chaque personne ne voit que les données autorisées ; les journées précédentes restent uniquement consultables.</p>{projectFinished && <p className="projectHint">Chantier clôturé : les accès ne peuvent plus être créés ni modifiés.</p>}
          <div className="projectTeamTabs" role="tablist" aria-label="Gestion de l'équipe">
            <button type="button" role="tab" aria-selected={teamView === "create"} className={teamView === "create" ? "isSelected" : ""} onClick={() => setTeamView("create")}>Créer un accès</button>
            <button type="button" role="tab" aria-selected={teamView === "team"} className={teamView === "team" ? "isSelected" : ""} onClick={() => setTeamView("team")}>Équipe <span>{activeConductors.length + pendingConductors.length + activeSiteManagers.length + pendingSiteManagers.length + projectStaff.length}</span></button>
          </div>
          {teamView === "create" ? <>
          <form className="projectAccessForm" onSubmit={(event) => void inviteCollaborator(event)}>
            <input name="email" type="text" required disabled={projectFinished} placeholder="Identifiant du collaborateur (nom, pseudo ou e-mail)" />
            <input name="password" type="text" required minLength={6} disabled={projectFinished} placeholder="Mot de passe à lui transmettre (6 caractères min.)" />
            <input name="phone_number" type="text" disabled={projectFinished} placeholder="Numéro de téléphone (facultatif)" />
            <label className="projectInlineCheck"><input type="checkbox" name="mvola_enabled" /> Mvola</label>
            <label className="projectInlineCheck"><input type="checkbox" name="call_enabled" defaultChecked /> Appel</label>
            {/* Le conducteur voit le même choix que l'administrateur (Chef de
                chantier / Consultation uniquement), sauf "Conducteur de
                travaux" qu'il ne peut pas créer lui-même. Le rattachement se
                fait automatiquement sous lui côté serveur, pas besoin de le
                choisir ici. */}
            <select name="role" value={createRole} disabled={projectFinished} onChange={(event) => { setCreateRole(event.target.value); setCreateParentAssignmentId(""); setCreateIsAssociate(false); }}>
              {isAdmin && <option value="works_manager">Conducteur de travaux</option>}
              <option value="site_manager">Chef de chantier</option>
              <option value="viewer">Consultation uniquement</option>
            </select>
            {isAdmin && createRole === "site_manager" && <select value={createParentAssignmentId} disabled={projectFinished} onChange={(event) => setCreateParentAssignmentId(event.target.value)}><option value="">Rattacher sous quel conducteur ?</option>{activeConductors.map((item) => <option key={item.id} value={item.id}>{item.displayName || `Conducteur ${item.user_id.slice(0, 8)}`}</option>)}</select>}
            {isAdmin && createRole === "works_manager" && <label className="projectInlineCheck"><input type="checkbox" checked={createIsAssociate} disabled={projectFinished} onChange={(event) => setCreateIsAssociate(event.target.checked)} /> Conducteur associé (paye distincte, réglable dans Taux de paye)</label>}
            <div className="projectPermissionButtons" role="group" aria-label="Autorisations du collaborateur">{([['reports', 'Rapports'], ['stock', 'Stocks : ajout et enregistrement'], ['photos', 'Photos']] as const).map(([permission, label]) => <button key={permission} type="button" disabled={projectFinished} className={accessPermissions[permission] ? "isSelected" : ""} aria-pressed={accessPermissions[permission]} onClick={() => setAccessPermissions((current) => ({ ...current, [permission]: !current[permission] }))}>{accessPermissions[permission] ? "✓ " : ""}{label}</button>)}</div>
            <button type="submit" disabled={busy || projectFinished}>{busy ? "Création en cours…" : projectFinished ? "Accès désactivés" : `Créer le compte ${createRole === "works_manager" ? "conducteur" : createRole === "site_manager" ? "chef de chantier" : "de consultation"}`}</button>
            {accessFeedback && <p className={`projectAccessStatus ${accessFeedback.kind}`} role="status" aria-live="polite">{accessFeedback.text}</p>}
          </form>
          {/* Un ouvrier, manœuvre ou autre membre d'équipe n'a pas de mot de
              passe : ni l'administrateur ni le conducteur ne devaient avoir
              de moyen simple de l'ajouter en dehors du rapport journalier ou
              du compte chef de chantier — corrigé ici. */}
          <div className="projectStaffPanelForm" style={{ marginTop: "18px", paddingTop: "16px", borderTop: "1px solid var(--line)" }}>
            <h3>Ajouter un ouvrier, manœuvre ou autre membre (sans identifiant)</h3>
            {!projectFinished ? <form className="projectStaffForm" onSubmit={(event) => void addStaffMember(event)}><input name="full_name" required placeholder="Nom et prénom de l’employé" /><input name="role" placeholder="Poste (ouvrier, manœuvre, maçon, aide…)" /><input name="mvola" placeholder="Numéro de téléphone (facultatif)" /><label className="projectInlineCheck"><input type="checkbox" name="mvola_enabled" defaultChecked /> Mvola</label><label className="projectInlineCheck"><input type="checkbox" name="call_enabled" defaultChecked /> Appel</label><button disabled={busy}>+ Ajouter à l’équipe</button></form> : <p className="projectHint">Chantier clôturé : l’équipe ne peut plus être modifiée.</p>}
          </div>
          </> : <div className="projectTeamRoster">
            {isAdmin && <article><h3 style={{cursor:"pointer"}} onClick={() => setExpandedRoster((current) => ({ ...current, conductors: !current.conductors }))}>{expandedRoster.conductors ? "▾" : "▸"} Conducteurs</h3><p>{activeConductors.length} actif(s) · {pendingConductors.length} en attente</p>{expandedRoster.conductors && <>{activeConductors.map((item) => <div className="projectTeamMember" key={item.id} data-revealable onClick={() => isAdmin && !projectFinished && setRevealedKey((current) => current === `assignment-${item.id}` ? null : `assignment-${item.id}`)}><strong style={isAdmin ? {cursor:"pointer",textDecoration:"underline"} : undefined} onClick={(event) => { event.stopPropagation(); isAdmin && setViewingAssignment(item); }}>Compte {conductorLabel(item.id, "conducteur").toLowerCase()} · {item.displayName || item.email || item.user_id.slice(0, 8)}</strong>{phoneLink(item.phone_number)}<div className="flex flex-wrap items-center justify-end gap-2"><span className="active">Actif</span>{isAdmin && !projectFinished && revealedKey === `assignment-${item.id}` && <button type="button" className="rounded-lg border border-red-700 bg-white px-2 py-1 text-xs font-bold text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50" disabled={busy} onClick={(event) => { event.stopPropagation(); revokeAccess({ assignmentId: item.id }, "cet accès conducteur"); }}>Retirer</button>}</div></div>)}{pendingConductors.map((item) => <div className="projectTeamMember" key={item.id} data-revealable onClick={() => isAdmin && !projectFinished && setRevealedKey((current) => current === `invite-${item.id}` ? null : `invite-${item.id}`)}><strong>{item.email}</strong><div className="flex flex-wrap items-center justify-end gap-2"><span className="pending">En attente</span>{isAdmin && !projectFinished && revealedKey === `invite-${item.id}` && <><button type="button" className="rounded-lg border border-emerald-700 bg-white px-2 py-1 text-xs font-bold text-emerald-800 transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50" disabled={busy} onClick={(event) => { event.stopPropagation(); openInvitationEdit(item); }}>Modifier</button><button type="button" className="rounded-lg border border-red-700 bg-white px-2 py-1 text-xs font-bold text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50" disabled={busy} onClick={(event) => { event.stopPropagation(); revokeAccess({ invitationId: item.id }, "cette demande d’accès"); }}>Supprimer</button></>}</div></div>)}{activeConductors.length + pendingConductors.length === 0 && <small>Aucun conducteur créé.</small>}</>}</article>}
            <article><h3 style={{cursor:"pointer"}} onClick={() => setExpandedRoster((current) => ({ ...current, siteManagers: !current.siteManagers }))}>{expandedRoster.siteManagers ? "▾" : "▸"} Chefs de chantier</h3><p>{activeSiteManagers.length} actif(s) · {pendingSiteManagers.length} en attente</p>{expandedRoster.siteManagers && <>{activeSiteManagers.map((item) => <div className="projectTeamMember" key={item.id} data-revealable onClick={() => isAdmin && !projectFinished && setRevealedKey((current) => current === `assignment-${item.id}` ? null : `assignment-${item.id}`)}><strong style={isAdmin ? {cursor:"pointer",textDecoration:"underline"} : undefined} onClick={(event) => { event.stopPropagation(); isAdmin && setViewingAssignment(item); }}>Compte chef de chantier · {item.displayName || item.email || item.user_id.slice(0, 8)}</strong>{phoneLink(item.phone_number)}<div className="flex flex-wrap items-center justify-end gap-2"><span className="active">Actif</span>{isAdmin && !projectFinished && revealedKey === `assignment-${item.id}` && <button type="button" className="rounded-lg border border-red-700 bg-white px-2 py-1 text-xs font-bold text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50" disabled={busy} onClick={(event) => { event.stopPropagation(); revokeAccess({ assignmentId: item.id }, "cet accès chef de chantier"); }}>Retirer</button>}</div></div>)}{pendingSiteManagers.map((item) => <div className="projectTeamMember" key={item.id} data-revealable onClick={() => isAdmin && !projectFinished && setRevealedKey((current) => current === `invite-${item.id}` ? null : `invite-${item.id}`)}><strong>{item.email}</strong><div className="flex flex-wrap items-center justify-end gap-2"><span className="pending">En attente</span>{isAdmin && !projectFinished && revealedKey === `invite-${item.id}` && <><button type="button" className="rounded-lg border border-emerald-700 bg-white px-2 py-1 text-xs font-bold text-emerald-800 transition hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50" disabled={busy} onClick={(event) => { event.stopPropagation(); openInvitationEdit(item); }}>Modifier</button><button type="button" className="rounded-lg border border-red-700 bg-white px-2 py-1 text-xs font-bold text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50" disabled={busy} onClick={(event) => { event.stopPropagation(); revokeAccess({ invitationId: item.id }, "cette demande d’accès"); }}>Supprimer</button></>}</div></div>)}{activeSiteManagers.length + pendingSiteManagers.length === 0 && <small>Le conducteur créera les chefs de chantier qui lui sont rattachés.</small>}</>}</article>
            {isAdmin && removedAssignments.length > 0 && <article><h3 style={{cursor:"pointer"}} onClick={() => setExpandedRoster((current) => ({ ...current, removed: !current.removed }))}>{expandedRoster.removed ? "▾" : "▸"} Accès retirés (historique)</h3><p>{removedAssignments.length} accès retiré(s)</p>{expandedRoster.removed && removedAssignments.map((item) => <div className="projectTeamMember" key={item.id} style={{ opacity: 0.6 }}><strong>{item.role === "works_manager" ? "Compte conducteur" : "Compte chef de chantier"} · {item.displayName || item.email || item.user_id.slice(0, 8)}</strong><span>Retiré le {item.revoked_at ? date.format(new Date(item.revoked_at)) : ""}</span></div>)}</article>}
            <article><h3>Équipe déclarée</h3><p>{projectStaff.length} personne(s) active(s)</p>{projectStaff.length ? projectStaff.map((member) => <div className="projectTeamMember" key={member.id} data-revealable onClick={() => isAdmin && !member.linked_assignment_id && setRevealedKey((current) => current === `staff-${member.id}` ? null : `staff-${member.id}`)}><strong>{member.full_name}</strong>{phoneLink(member.mvola_number)}<div className="flex flex-wrap items-center justify-end gap-2" onClick={(event) => event.stopPropagation()}>{(() => {
                const canEditRole = isAdmin || accessRole === "works_manager";
                if (canEditRole && editingRoleStaffId === member.id) {
                  return member.linked_assignment_id
                    ? <select autoFocus disabled={busy} defaultValue={member.role_name || "Conducteur"} onChange={(event) => void updateStaffRoleName(member, event.target.value)} onBlur={() => setEditingRoleStaffId(null)}>
                        <option value="Conducteur">Conducteur</option>
                        <option value="Conducteur associé">Conducteur associé</option>
                        <option value="Chef de chantier">Chef de chantier</option>
                        <option value="Ouvrier">Ouvrier</option>
                      </select>
                    : <input autoFocus disabled={busy} defaultValue={member.role_name || ""} style={{ width: "140px" }} onBlur={(event) => void updateStaffRoleName(member, event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") (event.target as HTMLInputElement).blur(); if (event.key === "Escape") setEditingRoleStaffId(null); }} />;
                }
                return <span onClick={canEditRole ? () => setEditingRoleStaffId(member.id) : undefined} style={canEditRole ? { cursor: "pointer", textDecoration: "underline" } : undefined} title={canEditRole ? "Cliquer pour changer le poste" : undefined}>{member.role_name || "Équipe"}</span>;
              })()}
              {/* Un conducteur/chef a sa fiche créée et retirée automatiquement avec son accès (voir plus haut "Conducteurs"/"Chefs de chantier") : pas de chef à lui désigner, ni de retrait séparé possible ici. */}{!member.linked_assignment_id && (isAdmin || accessRole === "works_manager") && activeSiteManagers.length > 0 ? <select value={member.supervisor_assignment_id || ""} disabled={busy || projectFinished} onChange={(event) => void updateStaffSupervisor(member, event.target.value)}><option value="">Chef non désigné</option>{activeSiteManagers.map((item) => <option key={item.id} value={item.id}>{item.displayName || `Chef ${item.user_id.slice(0, 8)}`}</option>)}</select> : null}{!member.linked_assignment_id && isAdmin && revealedKey === `staff-${member.id}` && <button type="button" className="rounded-lg border border-red-700 bg-white px-2 py-1 text-xs font-bold text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50" disabled={busy} onClick={() => void adminDeleteStaffMember(member)}>Retirer</button>}</div></div>) : <small>Les membres seront affichés dès leur ajout dans le rapport journalier.</small>}
              {isAdmin && removedStaff.length > 0 && <div style={{ marginTop: "10px" }}>
                <small style={{cursor:"pointer",textDecoration:"underline"}} onClick={() => setExpandedRoster((current) => ({ ...current, removedStaff: !current.removedStaff }))}>{expandedRoster.removedStaff ? "▾" : "▸"} {removedStaff.length} membre(s) retiré(s) (historique)</small>
                {expandedRoster.removedStaff && removedStaff.map((member) => <div className="projectTeamMember" key={member.id} style={{ opacity: 0.6 }}><strong>{member.full_name}</strong><span>{member.role_name || "Équipe"} · Retiré le {member.deleted_at ? date.format(new Date(member.deleted_at)) : ""}</span></div>)}
              </div>}
            </article>
          </div>}
          </>}
        </section>}
        {editingInvitation && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={() => setEditingInvitation(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(420px,100%)" }}>
            <h2 className="font-bold text-xl mb-4">Modifier l’adresse e-mail</h2>
            <input
              type="email"
              className="w-full border p-3 rounded-lg mb-2"
              value={editingInvitationEmail}
              onChange={(event) => setEditingInvitationEmail(event.target.value)}
              autoFocus
            />
            <div style={{ display: "flex", gap: "10px", marginTop: "10px" }}>
              <button type="button" className="button" disabled={busy} onClick={() => void editPendingInvitation(editingInvitation, editingInvitationEmail)}>Enregistrer</button>
              <button type="button" className="ghostButton" onClick={() => setEditingInvitation(null)}>Annuler</button>
            </div>
          </div>
        </div>, document.body)}
        {viewingAssignment && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={() => setViewingAssignment(null)}>
          <div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(420px,100%)" }}>
            <h2 className="font-bold text-xl mb-4">{viewingAssignment.role === "works_manager" ? "Compte conducteur" : "Compte chef de chantier"}</h2>
            <div className="priceDetailGrid" style={{gridTemplateColumns:"1fr"}}>
              <div className="priceDetailStat"><span>Nom</span><strong>{viewingAssignment.displayName || "—"}</strong></div>
              <div className="priceDetailStat"><span>Identifiant (e-mail)</span><strong>{viewingAssignment.email || "—"}</strong></div>
              <div className="priceDetailStat"><span>Mot de passe</span><strong>{viewingAssignment.access_password || "Non disponible (créé avant cette fonctionnalité)"}</strong></div>
              <div className="priceDetailStat"><span>Adresse de connexion</span><strong>{typeof window !== "undefined" ? `${window.location.origin}/login` : "/login"}</strong></div>
            </div>
            {viewingAssignment.role === "works_manager" && <p className="projectHint" style={{marginTop:"10px"}}>Poste actuel : <strong>{conductorLabel(viewingAssignment.id, "Conducteur")}</strong> — pour le changer (ex. "Conducteur associé"), clique sur le poste de cette personne dans "Équipe déclarée" ci-dessus.</p>}
            <p className="projectHint" style={{marginTop:"10px"}}>Ces informations ne sont visibles que par l’administrateur — jamais par le titulaire du compte lui-même.</p>
            <button type="button" className="ghostButton mt-5" onClick={() => setViewingAssignment(null)}>Fermer</button>
          </div>
        </div>, document.body)}
        <section className={`projectSiteCard projectPlanning${isAdmin ? " mobAdminOrder11" : ""}`}><div className="projectCardHead"><div><p className="projectEyebrow">PLANNING DAO</p><h2>Avancement des travaux</h2></div><span>{projectTasks.filter((item) => item.status === "completed").length}/{projectTasks.length} terminée(s)</span></div>{projectTasks.length ? <div className="projectTaskList">{projectTasks.map((task) => { const editable = canEditOwnCurrentRecord(task); const checklistCount = task.checklist?.length ?? 0; return <article key={task.id}><div><strong>{task.title}</strong><small>{task.planned_start_date || "—"} → {task.planned_end_date || "—"}{!editable && " · consultation"}</small><small className={checklistCount ? "projectChecklistBadge isReady" : "projectChecklistBadge"}>{checklistCount ? `✓ ${checklistCount} sous-tâche(s) générée(s)` : "Aucune sous-tâche générée"}</small></div><select value={task.status} disabled={!editable} onChange={(event) => void updateTask(task.id, { status: event.target.value })}><option value="planned">Planifiée</option><option value="active">En cours</option><option value="blocked">Bloquée</option><option value="completed">Terminée</option></select><label>{number(task.progress_percent)} %<input type="range" min="0" max="100" disabled={!editable} value={number(task.progress_percent)} onChange={(event) => void updateTask(task.id, { progress_percent: number(event.target.value) })} /></label></article>; })}</div> : <p className="projectEmptyText">Le planning est importé automatiquement depuis le DAO. {isAdmin && online ? "Vous pouvez le relancer ci-dessous." : "Il sera visible dès que l’import sera terminé."}</p>}{isAdmin && <button type="button" className="secondary mt-3" disabled={!online || busy || projectFinished} onClick={() => void importDaoTasks()}>{busy ? "Importation…" : projectFinished ? "Planning archivé" : "Importer le planning du DAO"}</button>}{isAdmin && projectTasks.length > 0 && <><button type="button" className="secondary mt-2" disabled={!online || busy || projectFinished} onClick={() => void generateTaskChecklists()}>{busy ? "Génération…" : `Générer les sous-tâches IA (${projectTasks.filter((task) => (task.checklist?.length ?? 0) > 0).length}/${projectTasks.length} prêtes)`}</button>{checklistStatus && <p className={`projectAccessStatus ${checklistStatus.kind}`} role="status" aria-live="polite">{checklistStatus.text}</p>}</>}<p className="projectHint mt-2">Les étapes ne sont pas créées manuellement : elles conservent la structure du DAO. Chaque niveau consulte les saisies de l’équipe sous sa responsabilité, sans les modifier.</p></section>
        <section className={`projectSiteCard projectReports${isAdmin ? " mobAdminOrder5" : ""}`}>
          <div className="projectCardHead"><div><p className="projectEyebrow">TERRAIN</p><h2>Rapports journaliers</h2></div><span>{projectReports.length} rapport(s) · {projectPhotos.length} photo(s)</span></div>
          {canOperate && <>
            <div className="projectReportWizard">
              <div className="projectReportChips">
                <button type="button" className="projectReportChip" onClick={() => setOpenReportField("date")}><span>Date</span><strong>{reportDraft.date ? date.format(new Date(reportDraft.date)) : "Choisir"}</strong></button>
                <button type="button" className="projectReportChip" onClick={() => setOpenReportField("weather")}><span>Météo</span><strong>{reportDraft.weather || "Choisir"}</strong></button>
                <button type="button" className="projectReportChip" onClick={() => setOpenReportField("workers")}><span>Effectif</span><strong>{todayPresentCount ? `${todayPresentCount} présent(s)` : "Choisir"}</strong></button>
                <button type="button" className="projectReportChip" onClick={() => setOpenReportField("completedWork")}><span>Travaux réalisés</span><strong>{reportSelectedTasks.length ? `${reportSelectedTasks.length} étape(s)` : reportDraft.completedWork ? "Renseigné" : "Choisir"}</strong></button>
                <button type="button" className="projectReportChip" onClick={() => setOpenReportField("nextDayPlan")}><span>Travaux prévus demain</span><strong>{reportTomorrowTaskIds.length || reportDraft.nextDayPlan ? "Renseigné" : "Choisir"}</strong></button>
                {canUseReportStock && <button type="button" className="projectReportChip" onClick={() => setOpenReportField("materials")}><span>Matériaux utilisés</span><strong>{reportConsumptionDraft.length ? `${reportConsumptionDraft.length} matériau(x)` : "Choisir"}</strong></button>}
                {canManageStock && <button type="button" className="projectReportChip" onClick={() => setOpenReportField("tomorrowMaterials")}><span>Matériaux prévus demain</span><strong>{reportTomorrowMaterials.length ? `${reportTomorrowMaterials.length} matériau(x)` : "Choisir"}</strong></button>}
              </div>
              <textarea className="projectReportComment" value={reportDraft.issues} onChange={(event) => setReportDraft((draft) => ({ ...draft, issues: event.target.value }))} placeholder="Commentaire, remarque ou retard à signaler" />
              <div className="projectReportPhotoQueue">
                <label className="projectPhotoButton">📷 Ajouter des photos<input type="file" accept="image/*" capture="environment" multiple style={{ display: "none" }} onChange={(event) => handleReportPhotoSelect(event.target.files)} /></label>
                {reportPhotoDraft.length > 0 && <div className="projectPhotoThumbs">{reportPhotoDraft.map((item) => <div className="projectPhotoThumb" key={item.id}><img src={item.previewUrl} alt="" /><button type="button" onClick={() => removeReportPhoto(item.id)}>×</button></div>)}</div>}
              </div>
              <button type="button" className="projectReportSubmit" disabled={reportSubmitting} onClick={() => { setReportSubmitStatus(null); setViewingReportSummary(true); }}>{reportSubmitting ? "Envoi en cours…" : "Valider et envoyer le rapport"}</button>
            </div>
          </>}
          {!canOperate && <p className="projectHint">Historique en lecture seule. Vous pouvez signaler une erreur avec une annotation.</p>}
          {viewingReportSummary && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={() => setViewingReportSummary(false)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(520px,100%)", display: "flex", flexDirection: "column", maxHeight: "85vh" }}>
            <h2 className="font-bold text-xl mb-4" style={{ flex: "0 0 auto" }}>Confirmer le rapport du {date.format(new Date(reportDraft.date || today))}</h2>
            <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", paddingRight: "4px" }}>
              <p className="projectHint">Vérifiez le récapitulatif avant l’envoi définitif — le rapport, les photos et la déduction de stock seront enregistrés dès la confirmation.</p>
              <div className="priceDetailGrid" style={{ gridTemplateColumns: "1fr" }}>
                <div className="priceDetailStat"><span>Météo</span><strong>{reportDraft.weather || "Non renseignée"}</strong></div>
                <div className="priceDetailStat"><span>Effectif présent</span><strong>{todayPresentCount} personne(s)</strong></div>
                <div className="priceDetailStat"><span>Travaux réalisés</span><strong>{reportSelectedTasks.length ? reportSelectedTasks.map((item) => projectTasks.find((task) => task.id === item.task_id)?.title || "Étape").join(", ") : reportDraft.completedWork || "Non renseigné"}</strong></div>
                <div className="priceDetailStat"><span>Travaux prévus demain</span><strong>{reportTomorrowTaskIds.length ? reportTomorrowTaskIds.map((id) => projectTasks.find((task) => task.id === id)?.title || "Étape").join(", ") : reportDraft.nextDayPlan || "Non renseigné"}</strong></div>
                <div className="priceDetailStat"><span>Matériaux utilisés</span><strong>{reportConsumptionDraft.length ? reportConsumptionDraft.map((item) => { const material = projectMaterials.find((m) => m.id === item.material_id); return `${material?.designation || "Matériau"} : ${item.quantity} ${material?.unit || ""}`; }).join(", ") : "Aucun"}</strong></div>
                <div className="priceDetailStat"><span>Matériaux prévus demain</span><strong>{reportTomorrowMaterials.length ? reportTomorrowMaterials.map((item) => { const material = projectMaterials.find((m) => m.id === item.material_id); return `${material?.designation || "Matériau"} : ${item.quantity} ${material?.unit || ""}`; }).join(", ") : "Aucun"}</strong></div>
                <div className="priceDetailStat"><span>Commentaire</span><strong>{reportDraft.issues || "Aucun"}</strong></div>
                <div className="priceDetailStat"><span>Photos jointes</span><strong>{reportPhotoDraft.length}</strong></div>
              </div>
            </div>
            {reportSubmitStatus && <p className={`projectAccessStatus ${reportSubmitStatus.kind}`} style={{ flex: "0 0 auto", marginTop: "10px" }} role="status" aria-live="polite">{reportSubmitStatus.text}</p>}
            <div style={{ display: "flex", gap: "10px", marginTop: "14px", flex: "0 0 auto" }}>
              <button type="button" className="button" disabled={reportSubmitting} onClick={() => { void submitDailyReport().then((success) => { if (success) setViewingReportSummary(false); }); }}>{reportSubmitting ? "Envoi en cours…" : "Confirmer et envoyer"}</button>
              <button type="button" className="ghostButton" onClick={() => setViewingReportSummary(false)}>Modifier</button>
            </div>
          </div></div>, document.body)}
          <div className="projectStockSummaryList">{projectReports.length ? projectReports.map((report) => <div key={report.id} style={{ cursor: "pointer" }} onClick={() => setViewingReportDetail(report)}><span className="chipName">{date.format(new Date(report.report_date))}</span><span className="chipQty">{readerName(report.created_by || "")}</span></div>) : <p className="projectEmptyText">Aucun rapport journalier enregistré.</p>}</div>
        </section>
        {viewingReportDetail && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={() => setViewingReportDetail(null)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(560px,100%)", display: "flex", flexDirection: "column", maxHeight: "85vh" }}>
          <h2 className="font-bold text-xl mb-4" style={{ flex: "0 0 auto" }}>Rapport du {date.format(new Date(viewingReportDetail.report_date))}</h2>
          <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", paddingRight: "4px" }}>
            <div className="priceDetailGrid" style={{ gridTemplateColumns: "1fr" }}>
              <div className="priceDetailStat"><span>Rédigé par</span><strong>{readerName(viewingReportDetail.created_by || "")}</strong></div>
              <div className="priceDetailStat"><span>Effectif</span><strong>{number(viewingReportDetail.workers_present)} personne(s)</strong></div>
              <div className="priceDetailStat"><span>Météo</span><strong>{viewingReportDetail.weather || "Non indiquée"}</strong></div>
              <div className="priceDetailStat"><span>Travaux réalisés</span><strong>{viewingReportDetail.completed_work || "Aucun travail renseigné."}</strong></div>
              <div className="priceDetailStat"><span>Travaux prévus demain</span><strong>{viewingReportDetail.next_day_plan || "—"}</strong></div>
              {viewingReportDetail.issues && <div className="priceDetailStat"><span>Signalement</span><strong>{viewingReportDetail.issues}</strong></div>}
            </div>
            <h3 className="mt-3 font-bold">Matériaux utilisés</h3>
            {(() => { const usages = projectReportMaterialUsages.filter((usage) => usage.report_id === viewingReportDetail.id); return usages.length ? <div className="projectStockSummaryList">{usages.map((usage) => { const material = projectMaterials.find((item) => item.id === usage.material_id); return <div key={usage.id}><span className="chipName">{material?.designation || "Matériau"}</span><span className="chipQty">{number(usage.quantity)}</span></div>; })}</div> : <p className="projectEmptyText">Aucune consommation déclarée.</p>; })()}
            <h3 className="mt-3 font-bold">Photos</h3>
            {(() => { const reportPhotos = projectPhotos.filter((photo) => photo.report_id === viewingReportDetail.id); return reportPhotos.length ? <div className="projectPhotoThumbGrid">{reportPhotos.map((photo) => <button type="button" key={photo.id} className="projectPhotoThumbButton" onClick={() => void openPhoto(photo)}>{photoThumbnails[photo.id] ? <img src={photoThumbnails[photo.id]} alt="" /> : <span className="projectPhotoThumbLoading">…</span>}<small>{photoThumbLabel(photo)}</small></button>)}</div> : <p className="projectEmptyText">Aucune photo liée à ce rapport.</p>; })()}
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2" style={{ flex: "0 0 auto" }}>
            {isAdmin && <button type="button" className="rounded-lg border border-red-700 bg-white px-3 py-2 text-xs font-bold text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50" disabled={busy} onClick={() => void adminDeleteReport(viewingReportDetail)}>Supprimer ce rapport</button>}
            <button type="button" className="ghostButton mt-5" onClick={() => setViewingReportDetail(null)}>Fermer</button>
          </div>
        </div></div>, document.body)}
        {viewingPhotoUrl !== null && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={() => { setViewingPhotoUrl(null); setViewingPhotoRecord(null); }}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(640px,100%)" }}>
          <h2 className="font-bold text-xl mb-4">Photo</h2>
          {viewingPhotoUrl ? <img src={viewingPhotoUrl} alt="" style={{ width: "100%", maxHeight: "70vh", objectFit: "contain", borderRadius: "12px", background: "#eef4f0" }} /> : <p className="projectHint">Chargement de la photo…</p>}
          {viewingPhotoRecord?.photo_type === "delivery" && viewingPhotoRecord.caption && <div className="priceDetailGrid mt-3" style={{ gridTemplateColumns: "1fr" }}>
            <div className="priceDetailStat"><span>Achat</span><strong>{viewingPhotoRecord.caption}</strong></div>
            <div className="priceDetailStat"><span>Date</span><strong>{dateTime.format(new Date(viewingPhotoRecord.captured_at))}</strong></div>
          </div>}
          {isAdmin && viewingReportDetail && <button type="button" className="secondary mt-3" disabled={!online || aiAnalysisStatus?.kind === "info"} onClick={() => void analyzeReportPhotos(viewingReportDetail)}>{aiAnalysisStatus?.kind === "info" ? "Analyse en cours…" : "Analyser les photos (IA)"}</button>}
          {isAdmin && aiAnalysisStatus && <p className={`projectAccessStatus ${aiAnalysisStatus.kind}`} role="status" aria-live="polite">{aiAnalysisStatus.text}</p>}
          {/* "Historique des achats" fabrique une photo à la volée (juste pour l'affichage,
              elle n'existe pas dans project_photos) : on ne propose la suppression que
              pour une vraie photo enregistrée, sinon la suppression n'aurait aucun effet. */}
          {isAdmin && viewingPhotoRecord && photos.some((item) => item.id === viewingPhotoRecord.id) && <button type="button" className="rounded-lg border border-red-700 bg-white px-3 py-2 text-xs font-bold text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50 mt-3" disabled={busy} onClick={() => void adminDeletePhoto(viewingPhotoRecord)}>Supprimer cette photo</button>}
          <button type="button" className="ghostButton mt-5" onClick={() => { setViewingPhotoUrl(null); setViewingPhotoRecord(null); }}>Fermer</button>
        </div></div>, document.body)}
        {aiAnalysisResult && viewingReportDetail && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={() => setAiAnalysisResult(null)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(480px,100%)", display: "flex", flexDirection: "column", maxHeight: "85vh" }}>
          <h2 className="font-bold text-xl mb-4" style={{ flex: "0 0 auto" }}>Analyse IA — {date.format(new Date(viewingReportDetail.report_date))}</h2>
          <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", paddingRight: "4px" }}>
            <p className="projectHint">Estimation visuelle approximative — à vérifier sur place, pas une certitude.</p>
            <div className="priceDetailGrid" style={{ gridTemplateColumns: "1fr" }}>
              <div className={`priceDetailStat${aiAnalysisResult.verdict === "incoherent" ? " projectAlert" : ""}`}><span>Verdict</span><strong>{aiAnalysisResult.verdict === "coherent" ? "Consommation raisonnable" : aiAnalysisResult.verdict === "incoherent" ? "Écart important détecté" : "Incertain"}</strong></div>
              <div className="priceDetailStat"><span>Confiance IA</span><strong>{Math.round(aiAnalysisResult.confidence <= 1 ? aiAnalysisResult.confidence * 100 : aiAnalysisResult.confidence)} %</strong></div>
              <div className="priceDetailStat"><span>Résumé</span><strong>{aiAnalysisResult.summary}</strong></div>
            </div>
            <h3 className="mt-3 font-bold">Observations</h3>
            <ul style={{ margin: 0, paddingLeft: "18px" }}>{aiAnalysisResult.observations.map((observation, index) => <li key={index}>{observation}</li>)}</ul>
          </div>
          {aiAnalysisStatus && <p className={`projectAccessStatus ${aiAnalysisStatus.kind}`} style={{ flex: "0 0 auto", marginTop: "10px" }} role="status" aria-live="polite">{aiAnalysisStatus.text}</p>}
          <div style={{ display: "flex", gap: "10px", marginTop: "14px", flex: "0 0 auto" }}>
            <button type="button" className="button" disabled={aiAnalysisStatus?.kind === "info"} onClick={() => void reportAiAnalysisAsNote()}>{aiAnalysisStatus?.kind === "info" ? "Envoi…" : "Signaler"}</button>
            <button type="button" className="ghostButton" onClick={() => { setAiAnalysisResult(null); setAiAnalysisStatus(null); }}>Fermer</button>
          </div>
        </div></div>, document.body)}
        {openReportField === "date" && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={() => setOpenReportField(null)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(320px,100%)" }}><h2 className="font-bold text-xl mb-4">Date du rapport</h2><input type="date" className="w-full border p-3 rounded-lg mb-2" value={reportDraft.date} onChange={(event) => setReportDraft((draft) => ({ ...draft, date: event.target.value }))} autoFocus /><button type="button" className="button mt-3" onClick={() => setOpenReportField(null)}>Valider</button></div></div>, document.body)}
        {openReportField === "weather" && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={() => setOpenReportField(null)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(360px,100%)" }}>
          <h2 className="font-bold text-xl mb-4">Météo du jour</h2>
          <div className="projectChipChoices">{WEATHER_OPTIONS.map((option) => <button type="button" key={option} className={reportDraft.weather === option ? "isSelected" : ""} onClick={() => setReportDraft((draft) => ({ ...draft, weather: option }))}>{option}</button>)}</div>
          {(reportDraft.weather === "Pluvieux" || reportDraft.weather === "Orageux") && <div style={{ marginTop: "14px" }}>
            <p className="projectHint">Cette météo a-t-elle arrêté le travail aujourd’hui ?</p>
            <div className="projectChipChoices"><button type="button" className={reportDraft.issues.includes("Travail arrêté à cause de la météo") ? "isSelected" : ""} onClick={() => toggleWeatherImpact()}>Travail arrêté à cause de la météo</button></div>
          </div>}
          <button type="button" className="button mt-3" onClick={() => setOpenReportField(null)}>Valider</button>
        </div></div>, document.body)}
        {openReportField === "workers" && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={() => setOpenReportField(null)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(480px,100%)" }}>
          <h2 className="font-bold text-xl mb-4">Effectif présent</h2>
          <p className="projectHint">Cliquez chaque personne présente aujourd’hui. Le compte et le rapport se mettent à jour automatiquement.</p>
          <form className="projectStaffForm" onSubmit={(event) => void addStaffMember(event)}><input name="full_name" required placeholder="Nom et prénom de l’employé" /><input name="role" placeholder="Poste (maçon, aide, magasinier…)" /><input name="mvola" placeholder="Numéro de téléphone (facultatif)" /><label className="projectInlineCheck"><input type="checkbox" name="mvola_enabled" defaultChecked /> Mvola</label><label className="projectInlineCheck"><input type="checkbox" name="call_enabled" defaultChecked /> Appel</label><button disabled={busy}>+ Ajouter à l’équipe</button></form>
          <div className="projectAttendanceList">{projectStaff.length ? projectStaff.map((member) => { const entry = todayAttendance.find((item) => item.staff_member_id === member.id); const editable = canRecordAttendance && (!entry?.recorded_by || entry.recorded_by === userId); return <button type="button" key={member.id} disabled={!editable} className={entry?.present ? "present" : "absent"} onClick={() => void toggleAttendance(member)}><strong>{member.full_name}</strong><span>{member.role_name || "Employé"}</span><small>{entry?.present ? "Présent" : "Absent"}{!editable ? " · consultation" : ""}</small></button>; }) : <p className="projectEmptyText">Ajoutez les employés avant de marquer leur présence.</p>}</div>
          <button type="button" className="button mt-3" onClick={() => setOpenReportField(null)}>Valider</button>
        </div></div>, document.body)}
        {openReportField === "completedWork" && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={() => { setOpenReportField(null); setTaskChecklistTarget(null); }}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(480px,100%)" }}>
          {taskChecklistTarget ? (() => {
            const task = taskChecklistTarget;
            const staged = reportSelectedTasks.find((item) => item.task_id === task.id);
            const progress = staged ? staged.progress_percent : number(task.progress_percent);
            const status = staged ? staged.status : task.status;
            const checklist = staged?.checklist ?? task.checklist ?? [];
            return <>
              <h2 className="font-bold text-xl mb-4">{task.title}</h2>
              {checklist.length ? <>
                <p className="projectHint">Sélectionnez la ou les sous-tâches faites aujourd’hui.</p>
                <div className="projectChipChoices">{checklist.map((item) => <button type="button" key={item.id} className={item.done ? "isSelected" : ""} onClick={() => toggleChecklistItem(task, item.id)}>{item.done ? "✓ " : ""}{item.label}</button>)}</div>
                <p className="projectHint" style={{ marginTop: "10px" }}>{progress} % réalisé — {checklist.filter((item) => item.done).length}/{checklist.length} sous-tâche(s)</p>
              </> : <>
                <p className="projectHint">Aucune sous-tâche générée pour cette étape. Ajustez la progression manuellement.</p>
                <select value={status} onChange={(event) => stageTaskProgress(task.id, progress, event.target.value)}><option value="planned">Planifiée</option><option value="active">En cours</option><option value="blocked">Bloquée</option><option value="completed">Terminée</option></select>
                <label>{progress} %<input type="range" min="0" max="100" value={progress} onChange={(event) => stageTaskProgress(task.id, number(event.target.value), status)} /></label>
              </>}
              <button type="button" className="button mt-3" onClick={() => setTaskChecklistTarget(null)}>Valider</button>
            </>;
          })() : <>
            <h2 className="font-bold text-xl mb-4">Travaux réalisés aujourd’hui</h2>
            <p className="projectHint">Cliquez une étape du planning pour cocher ses sous-tâches faites aujourd’hui.</p>
            <div className="projectChipChoices">{projectTasks.map((task) => {
              const staged = reportSelectedTasks.find((item) => item.task_id === task.id);
              const progress = staged ? staged.progress_percent : number(task.progress_percent);
              return <button type="button" key={task.id} className={staged ? "isSelected" : ""} onClick={() => setTaskChecklistTarget(task)}>{task.title}{progress ? ` · ${progress}%` : ""}</button>;
            })}</div>
            <textarea className="w-full border p-3 rounded-lg mt-3" rows={3} placeholder="Autre travail non planifié, précisions…" value={reportDraft.completedWork} onChange={(event) => setReportDraft((draft) => ({ ...draft, completedWork: event.target.value }))} />
            <button type="button" className="button mt-3" onClick={() => setOpenReportField(null)}>Terminer</button>
          </>}
        </div></div>, document.body)}
        {openReportField === "nextDayPlan" && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={() => { setOpenReportField(null); setTaskChecklistTarget(null); }}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(480px,100%)" }}>
          {taskChecklistTarget ? (() => {
            const task = taskChecklistTarget;
            const checklist = task.checklist ?? [];
            return <>
              <h2 className="font-bold text-xl mb-4">{task.title}</h2>
              {checklist.length ? <>
                <p className="projectHint">Sélectionnez la ou les sous-tâches prévues demain.</p>
                <div className="projectChipChoices">{checklist.map((item) => { const line = `- ${task.title} : ${item.label}`; const selected = reportDraft.nextDayPlan.split("\n").includes(line); return <button type="button" key={item.id} className={selected ? "isSelected" : ""} onClick={() => toggleTomorrowChecklistItem(task, item)}>{item.label}</button>; })}</div>
              </> : <>
                <p className="projectHint">Aucune sous-tâche générée pour cette étape.</p>
                <div className="projectChipChoices"><button type="button" className={reportTomorrowTaskIds.includes(task.id) ? "isSelected" : ""} onClick={() => toggleTomorrowTask(task)}>Prévoir toute l’étape demain</button></div>
              </>}
              <button type="button" className="button mt-3" onClick={() => setTaskChecklistTarget(null)}>Valider</button>
            </>;
          })() : <>
            <h2 className="font-bold text-xl mb-4">Travaux prévus demain</h2>
            <p className="projectHint">Cliquez une étape du planning pour choisir ses sous-tâches prévues demain.</p>
            <div className="projectChipChoices">{projectTasks.map((task) => <button type="button" key={task.id} className={reportDraft.nextDayPlan.includes(`- ${task.title}`) || reportTomorrowTaskIds.includes(task.id) ? "isSelected" : ""} onClick={() => setTaskChecklistTarget(task)}>{task.title}</button>)}</div>
            <textarea className="w-full border p-3 rounded-lg mt-3" rows={3} placeholder="Autre, si aucune étape ne correspond…" value={reportDraft.nextDayPlan} onChange={(event) => setReportDraft((draft) => ({ ...draft, nextDayPlan: event.target.value }))} />
            <button type="button" className="button mt-3" onClick={() => setOpenReportField(null)}>Terminer</button>
          </>}
        </div></div>, document.body)}
        {openReportField === "materials" && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={() => { setOpenReportField(null); setMaterialQtyTarget(null); }}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(480px,100%)" }}>
          {materialQtyTarget ? <>
            <h2 className="font-bold text-xl mb-4">Quantité utilisée — {materialQtyTarget.designation}</h2>
            <input type="number" min="0.001" step="any" className="w-full border p-3 rounded-lg mb-2" value={modalInputValue} onChange={(event) => setModalInputValue(event.target.value)} autoFocus placeholder={`En stock : ${number(materialQtyTarget.on_site_quantity)} ${materialQtyTarget.unit}`} />
            {materialQtyStatus && <p className={`projectAccessStatus ${materialQtyStatus.kind}`} role="status" aria-live="polite">{materialQtyStatus.text}</p>}
            <div style={{ display: "flex", gap: "10px", marginTop: "10px" }}><button type="button" className="button" onClick={() => confirmMaterialQty(number(modalInputValue))}>Valider</button><button type="button" className="ghostButton" onClick={() => setMaterialQtyTarget(null)}>Retour</button></div>
          </> : <>
            <h2 className="font-bold text-xl mb-4">Matériaux utilisés aujourd’hui</h2>
            <p className="projectHint">Seuls les matériaux disponibles en stock apparaissent ici.</p>
            <div className="projectChipChoices">{projectMaterials.filter((material) => number(material.on_site_quantity) > 0).map((material) => { const planned = reportConsumptionDraft.find((item) => item.material_id === material.id)?.quantity || 0; return <button type="button" className="projectMaterialChipRow" key={material.id} onClick={() => { setMaterialQtyTarget(material); setModalInputValue(""); setMaterialQtyStatus(null); }}><span className="chipName">{material.designation}</span><span className="chipQty">reste {Math.max(0, number(material.on_site_quantity) - planned)}</span></button>; })}</div>
            {reportConsumptionDraft.length > 0 && <ul className="projectConsumptionDraft">{reportConsumptionDraft.map((usage) => { const material = projectMaterials.find((item) => item.id === usage.material_id); return <li key={usage.material_id}>{material?.designation} : <b>{usage.quantity} {material?.unit}</b><button type="button" onClick={() => setReportConsumptionDraft((rows) => rows.filter((item) => item.material_id !== usage.material_id))}>Retirer</button></li>; })}</ul>}
            <button type="button" className="button mt-3" onClick={() => setOpenReportField(null)}>Terminer</button>
          </>}
        </div></div>, document.body)}
        {openReportField === "tomorrowMaterials" && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={() => { setOpenReportField(null); setTomorrowMaterialQtyTarget(null); }}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(480px,100%)" }}>
          {tomorrowMaterialQtyTarget ? <>
            <h2 className="font-bold text-xl mb-4">Besoin prévu demain — {tomorrowMaterialQtyTarget.designation}</h2>
            <input type="number" min="0.001" step="any" className="w-full border p-3 rounded-lg mb-2" value={modalInputValue} onChange={(event) => setModalInputValue(event.target.value)} autoFocus placeholder={`Disponible pour demain : ${Math.max(0, number(tomorrowMaterialQtyTarget.on_site_quantity) - (reportConsumptionDraft.find((usage) => usage.material_id === tomorrowMaterialQtyTarget.id)?.quantity || 0))} ${tomorrowMaterialQtyTarget.unit}`} />
            {tomorrowQtyStatus && <p className={`projectAccessStatus ${tomorrowQtyStatus.kind}`} role="status" aria-live="polite">{tomorrowQtyStatus.text}</p>}
            <div style={{ display: "flex", gap: "10px", marginTop: "10px" }}><button type="button" className="button" onClick={() => confirmTomorrowMaterialQty(number(modalInputValue))}>Valider</button><button type="button" className="ghostButton" onClick={() => setTomorrowMaterialQtyTarget(null)}>Retour</button></div>
          </> : <>
            <h2 className="font-bold text-xl mb-4">Matériaux prévus pour demain</h2>
            <div className="projectChipChoices">{projectMaterials.map((material) => { const staged = reportTomorrowMaterials.find((item) => item.material_id === material.id); const usedToday = reportConsumptionDraft.find((usage) => usage.material_id === material.id)?.quantity || 0; const available = Math.max(0, number(material.on_site_quantity) - usedToday); return <button type="button" key={material.id} className={`projectMaterialChipRow${staged ? " isSelected" : ""}`} onClick={() => { setTomorrowMaterialQtyTarget(material); setModalInputValue(staged ? String(staged.quantity) : ""); setTomorrowQtyStatus(null); }}><span className="chipName">{material.designation}</span><span className="chipQty">{staged ? staged.quantity : `disponible ${available}`}</span></button>; })}</div>
            <button type="button" className="button mt-3" onClick={() => finishTomorrowMaterials()}>Terminer</button>
          </>}
        </div></div>, document.body)}
        {viewingTomorrowSummary && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={() => setViewingTomorrowSummary(false)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(480px,100%)", display: "flex", flexDirection: "column", maxHeight: "85vh" }}>
          <h2 className="font-bold text-xl mb-4" style={{ flex: "0 0 auto" }}>Récapitulatif — matériaux de demain</h2>
          <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", paddingRight: "4px" }}>
            <h3 className="font-bold">Disponible pour demain</h3>
            <div className="projectChipChoices">{tomorrowMaterialsAvailability.filter((row) => row.shortfall === 0).length ? tomorrowMaterialsAvailability.filter((row) => row.shortfall === 0).map((row) => <p className="projectHint" key={row.item.material_id}>{row.material?.designation} : {row.item.quantity} {row.material?.unit}</p>) : <p className="projectEmptyText">Aucun.</p>}</div>
            <h3 className="mt-3 font-bold">Matériaux à commander</h3>
            <div className="projectChipChoices">{tomorrowMaterialShortfalls.map((row) => <p className="projectHint" key={row.item.material_id}>{row.material?.designation} : {row.shortfall} {row.material?.unit} manquant(s)</p>)}</div>
          </div>
          <div style={{ display: "flex", gap: "10px", marginTop: "14px", flex: "0 0 auto" }}>
            <button type="button" className="button" onClick={() => void confirmTomorrowMaterialsSummary()}>Confirmer</button>
            <button type="button" className="ghostButton" onClick={() => setViewingTomorrowSummary(false)}>Retour</button>
          </div>
        </div></div>, document.body)}
        <section className={`projectSiteCard projectAttendanceCard${isAdmin ? " mobAdminOrder6" : ""}`}>
          <div className="projectCardHead"><div><p className="projectEyebrow">PRÉSENCE DU JOUR</p><h2>Équipe sur le chantier</h2></div><span>{todayPresentCount}/{projectStaff.length} présent(s)</span></div>
          {attendanceMismatch && todayReport && <p className="notice danger">⚠️ Le rapport envoyé aujourd’hui indiquait {number(todayReport.workers_present)} présent(s), mais {todayPresentCount} sont pointés maintenant. Renvoyez le rapport du jour pour mettre ce chiffre à jour.</p>}
          <div className="projectAttendanceList">
            {projectStaff.length ? projectStaff.map((member) => {
              const entry = todayAttendance.find((item) => item.staff_member_id === member.id);
              const editable = canRecordAttendance && (!entry?.recorded_by || entry.recorded_by === userId);
              return <div className="projectTeamMember" key={member.id}>
                <strong>{member.full_name}</strong>
                {editable
                  ? <span role="button" tabIndex={0} style={{ cursor: "pointer", textDecoration: "underline", fontWeight: 700, color: entry?.present ? "#2f7a3a" : "#7a2b2d" }} onClick={() => void toggleAttendance(member)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); void toggleAttendance(member); } }}>{entry?.present ? "Présent" : "Absent"}</span>
                  : <span>{entry?.present ? "Présent" : "Absent"}{canRecordAttendance ? " · consultation" : ""}</span>}
              </div>;
            }) : <p className="projectEmptyText">Aucun employé déclaré.</p>}
          </div>
          <button type="button" className="secondary projectHistoryButton" onClick={() => setViewingAttendanceDetail(true)}>Voir l’historique</button>
        </section>
        {viewingAttendanceDetail && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={() => { setViewingAttendanceDetail(false); setViewingAttendanceDay(null); }}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(480px,100%)", display: "flex", flexDirection: "column", maxHeight: "85vh" }}>
          {viewingAttendanceDay ? <>
            <h2 className="font-bold text-xl mb-4">Présence — {date.format(new Date(viewingAttendanceDay))}</h2>
            <div className="projectNoteList projectNoteListScroll" style={{ flex: "1 1 auto", minHeight: 0 }}>{projectAttendance.filter((item) => item.report_date === viewingAttendanceDay && item.present).map((item) => { const member = projectStaff.find((row) => row.id === item.staff_member_id); return <div className="projectTeamMember" key={item.id}><strong>{member?.full_name || "Employé"}</strong></div>; })}</div>
            <button type="button" className="ghostButton mt-3" style={{ flex: "0 0 auto" }} onClick={() => setViewingAttendanceDay(null)}>Retour</button>
          </> : <>
            <h2 className="font-bold text-xl mb-4">Présence — historique par jour</h2>
            <div className="projectNoteList projectNoteListScroll" style={{ flex: "1 1 auto", minHeight: 0 }}>
              {(() => { const byDate = new Map<string, DailyAttendance[]>(); projectAttendance.filter((item) => item.report_date !== today).forEach((item) => { const rows = byDate.get(item.report_date) || []; rows.push(item); byDate.set(item.report_date, rows); }); const dates = [...byDate.keys()].sort((a, b) => b.localeCompare(a)); return dates.length ? dates.map((day) => <div className="projectTeamMember" key={day} style={{ cursor: "pointer" }} onClick={() => setViewingAttendanceDay(day)}><strong>{date.format(new Date(day))}</strong><span>{byDate.get(day)!.filter((item) => item.present).length} présent(s)</span></div>) : <p className="projectEmptyText">Aucun historique de présence.</p>; })()}
            </div>
            <button type="button" className="ghostButton mt-5" style={{ flex: "0 0 auto" }} onClick={() => setViewingAttendanceDetail(false)}>Fermer</button>
          </>}
        </div></div>, document.body)}
        <section className={`projectSiteCard projectMaterials${isAdmin ? " mobAdminOrder3" : ""}`} id="materialsCard">
          <div className="projectCardHead"><div><p className="projectEyebrow">DEMANDE</p><h2>Matériaux et stock</h2></div><span className={lowStock.length ? "projectAlert" : "projectOk"}>{lowStock.length ? `${lowStock.length} alerte(s)` : "Stock suivi"}</span></div>
          <p className="projectHint">Cette carte sert uniquement à faire une demande de matériau. Le stock réel se consulte dans « Mouvements de stock ».</p>

          {canManageExpenses && <div className="projectMaterialRequestWizard">
            <h3>Faire une demande</h3>
            <div className="projectReportChips">
              <button type="button" className="projectReportChip" onClick={() => setOpenRequestField("material")}><span>Matériau</span><strong>{requestDraft.material?.designation || "Choisir"}</strong></button>
              <button type="button" className="projectReportChip" onClick={() => setOpenRequestField("timing")}><span>Besoin</span><strong>{requestDraft.timing ? TIMING_LABELS[requestDraft.timing] : "Choisir"}</strong></button>
            </div>
            <input type="number" min="0.001" step="any" className="w-full border p-3 rounded-lg mt-2" placeholder="Quantité" value={requestDraft.quantity} onChange={(event) => setRequestDraft((draft) => ({ ...draft, quantity: event.target.value }))} />
            <button type="button" className="projectReportSubmit mt-3" disabled={busy} onClick={() => void submitMaterialRequest()}>Ajouter la demande</button>
            {requestStatus && <p className={`projectAccessStatus ${requestStatus.kind}`} role="status" aria-live="polite">{requestStatus.text}</p>}
          </div>}

          {canManageExpenses && <div className="projectNewLibraryMaterial">
            <h3>Nouveau matériau (bibliothèque de prix)</h3>
            <div className="projectMaterialForm">
              <input placeholder="Nom commercial" value={newLibraryMaterial.designation} onChange={(event) => setNewLibraryMaterial((draft) => ({ ...draft, designation: event.target.value }))} />
              <input placeholder="Unité" value={newLibraryMaterial.unite} onChange={(event) => setNewLibraryMaterial((draft) => ({ ...draft, unite: event.target.value }))} />
              <input placeholder="Fournisseur" value={newLibraryMaterial.fournisseur} onChange={(event) => setNewLibraryMaterial((draft) => ({ ...draft, fournisseur: event.target.value }))} />
              <input placeholder="Localisation" value={newLibraryMaterial.ville} onChange={(event) => setNewLibraryMaterial((draft) => ({ ...draft, ville: event.target.value }))} />
              <input type="number" min="0" step="any" placeholder="Prix (Ar)" value={newLibraryMaterial.prix} onChange={(event) => setNewLibraryMaterial((draft) => ({ ...draft, prix: event.target.value }))} />
              <button type="button" disabled={busy} onClick={() => void addMaterialToLibrary()}>+ Ajouter à la bibliothèque</button>
            </div>
            {newLibraryStatus && <p className={`projectAccessStatus ${newLibraryStatus.kind}`} role="status" aria-live="polite">{newLibraryStatus.text}</p>}
          </div>}
        </section>
        {openRequestField === "material" && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={() => { setOpenRequestField(null); setEditingLibraryMaterial(null); }}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(480px,100%)", display: "flex", flexDirection: "column", maxHeight: "85vh" }}>
          {editingLibraryMaterial ? <>
            <h2 className="font-bold text-xl mb-4">{editingLibraryMaterial.designation}</h2>
            <p className="projectHint">Modifiez le prix et/ou la localisation. Une localisation différente crée une nouvelle entrée (variante) plutôt que d’écraser celle-ci.</p>
            <label>Prix (Ar)<input type="number" min="0" step="any" className="w-full border p-3 rounded-lg mt-1 mb-2" value={editingLibraryPrice} onChange={(event) => setEditingLibraryPrice(event.target.value)} /></label>
            <label>Localisation<input className="w-full border p-3 rounded-lg mt-1" value={editingLibraryVille} onChange={(event) => setEditingLibraryVille(event.target.value)} placeholder="Ville / zone" /></label>
            {editingLibraryStatus && <p className={`projectAccessStatus ${editingLibraryStatus.kind}`} role="status" aria-live="polite">{editingLibraryStatus.text}</p>}
            <div style={{ display: "flex", gap: "10px", marginTop: "12px" }}>
              <button type="button" className="button" onClick={() => void saveLibraryMaterialEdit()}>Valider</button>
              <button type="button" className="ghostButton" onClick={() => setEditingLibraryMaterial(null)}>Retour</button>
            </div>
          </> : <>
            <h2 className="font-bold text-xl mb-4">Choisir un matériau</h2>
            <input className="w-full border p-3 rounded-lg mb-2" autoFocus placeholder="Filtrer par nom…" value={requestMaterialSearch} onChange={(event) => setRequestMaterialSearch(event.target.value)} />
            <p className="projectHint" style={{ marginBottom: "8px" }}>Clic pour choisir · clic long pour modifier le prix ou la localisation.</p>
            <div className="projectMaterialTileGrid projectNoteListScroll" style={{ flex: "1 1 auto", minHeight: 0 }}>{requestMaterialMatches.map((option) => <div key={option.id} className="projectMaterialTile" onMouseDown={() => startLongPress(option)} onMouseUp={cancelLongPress} onMouseLeave={cancelLongPress} onTouchStart={() => startLongPress(option)} onTouchEnd={cancelLongPress} onClick={() => handleRequestMaterialClick(option)}><strong>{option.designation}</strong><small>{priceLibraryPrice(option).toLocaleString("fr-FR")} Ar/{option.unite}</small><small>{option.ville || "Localisation non précisée"}</small></div>)}</div>
            {!requestMaterialMatches.length && <p className="projectHint">Aucun résultat. Ajoutez-le d’abord via « Nouveau matériau » ci-dessous.</p>}
            <button type="button" className="ghostButton mt-3" style={{ flex: "0 0 auto" }} onClick={() => setOpenRequestField(null)}>Fermer</button>
          </>}
        </div></div>, document.body)}
        {openRequestField === "timing" && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={() => setOpenRequestField(null)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(360px,100%)" }}>
          <h2 className="font-bold text-xl mb-4">Besoin pour quand ?</h2>
          <div className="projectChipChoices">{(["now", "tomorrow", "week"] as const).map((option) => <button type="button" key={option} className={requestDraft.timing === option ? "isSelected" : ""} onClick={() => { setRequestDraft((draft) => ({ ...draft, timing: option })); setOpenRequestField(null); }}>{TIMING_LABELS[option]}</button>)}</div>
          <button type="button" className="ghostButton mt-3" onClick={() => setOpenRequestField(null)}>Fermer</button>
        </div></div>, document.body)}
        <section className={`projectSiteCard projectMovementCard${isAdmin ? " mobAdminOrder4" : ""}`}>
          <div className="projectCardHead"><div><p className="projectEyebrow">MAGASIN</p><h2>Mouvements de stock</h2></div><span>{projectAllStockMovements.length} enregistré(s)</span></div>
          <p className="projectHint">Chaque réception, consommation ou ajustement est daté et historisé automatiquement.</p>
          <div className="projectStockSummaryList">{projectMaterials.length ? projectMaterials.map((material) => <div key={material.id}><span className="chipName">{material.designation}</span><span className="chipQty">{number(material.on_site_quantity)}</span></div>) : <p className="projectEmptyText">Aucun matériau suivi pour l’instant : le stock apparaît ici dès le premier achat validé.</p>}</div>
          <button type="button" className="secondary projectHistoryButton" onClick={() => setViewingStockDetail(true)}>Voir le détail et l’historique</button>
        </section>
        {viewingStockDetail && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={() => setViewingStockDetail(false)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(640px,100%)", display: "flex", flexDirection: "column", maxHeight: "85vh" }}>
          <h2 className="font-bold text-xl mb-4" style={{ flex: "0 0 auto" }}>Stock — détail et historique</h2>
          <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", paddingRight: "4px" }}>
            <h3 className="font-bold">Stock actuel</h3>
            <div className="projectStockSummaryList" style={{ maxHeight: "none" }}>{projectMaterials.length ? projectMaterials.map((material) => <div key={material.id}><span className="chipName">{material.designation}</span><span className="chipQty">{number(material.on_site_quantity)}</span></div>) : <p className="projectEmptyText">Aucun matériau suivi pour l’instant : le stock apparaît ici dès le premier achat validé.</p>}</div>
            {canManageStock && <form onSubmit={(event) => void recordStockMovement(event)} className="projectMovementForm"><select name="material_id" required defaultValue=""><option value="" disabled>Matériau concerné</option>{projectMaterials.map((material) => <option key={material.id} value={material.id}>{material.designation}</option>)}</select><select name="movement_type" defaultValue="delivery"><option value="delivery">Réception</option><option value="consumption">Consommation</option><option value="return">Retour</option><option value="adjustment">Ajustement inventaire</option></select><input name="quantity" type="number" min="0.001" step="any" placeholder="Quantité" required /><input name="movement_date" type="date" defaultValue={new Date().toISOString().slice(0, 10)} required /><input name="notes" placeholder="Bon, fournisseur ou note" /><button disabled={busy}>Enregistrer</button></form>}
            <h3 className="mt-4 font-bold">Historique complet</h3>
            <div className="projectMovementList" style={{ maxHeight: "none" }}>{projectAllStockMovements.length ? projectAllStockMovements.map((movement) => { const material = materials.find((item) => item.id === movement.material_id); return <div key={movement.id} className="flex flex-wrap items-center justify-between gap-2"><div><strong>{movement.movement_type === "delivery" ? "Réception" : movement.movement_type === "consumption" ? "Consommation" : movement.movement_type === "return" ? "Retour" : movement.movement_type === "loss" ? "Perte" : "Ajustement"}</strong><span>{number(movement.quantity)} {material?.unit || ""} · {material?.designation || "Matériau"}</span><small>{dateTime.format(new Date(movement.created_at || movement.movement_date))}{movement.notes ? ` · ${movement.notes}` : ""}</small></div>{isAdmin && <button type="button" className="rounded-lg border border-red-700 bg-white px-2 py-1 text-xs font-bold text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50" disabled={busy} onClick={() => void adminDeleteMovement(movement)}>Supprimer</button>}</div>; }) : <p className="projectEmptyText">Aucun mouvement enregistré.</p>}</div>
          </div>
          <button type="button" className="ghostButton mt-5" style={{ flex: "0 0 auto" }} onClick={() => setViewingStockDetail(false)}>Fermer</button>
        </div></div>, document.body)}
        <section className={`projectSiteCard projectPhotosCard${isAdmin ? " mobAdminOrder9" : ""}`}><div className="projectCardHead"><div><p className="projectEyebrow">CLASSEMENT</p><h2>Photos non classées</h2></div><span>{unassignedProjectPhotos.length} photo(s)</span></div><p className="projectHint">Les nouvelles photos sont classées directement dans leur rapport journalier. Cette liste contient seulement les anciennes photos à rattacher ou à consulter.</p><div className="projectPhotoThumbGrid">{unassignedProjectPhotos.length ? unassignedProjectPhotos.map((photo) => <button type="button" key={photo.id} className="projectPhotoThumbButton" onClick={() => void openPhoto(photo)}>{photoThumbnails[photo.id] ? <img src={photoThumbnails[photo.id]} alt="" /> : <span className="projectPhotoThumbLoading">…</span>}<small>{photoThumbLabel(photo)}</small></button>) : <p className="projectEmptyText">Toutes les photos du chantier sont classées dans un rapport journalier.</p>}</div>
          {isAdmin && deletedProjectPhotos.length > 0 && <div style={{ marginTop: "12px" }}>
            <small style={{cursor:"pointer",textDecoration:"underline"}} onClick={() => setViewingDeletedPhotos((current) => !current)}>{viewingDeletedPhotos ? "▾" : "▸"} {deletedProjectPhotos.length} photo(s) supprimée(s) (historique)</small>
            {viewingDeletedPhotos && <div className="projectStockSummaryList" style={{ marginTop: "8px" }}>{deletedProjectPhotos.map((photo) => <div key={photo.id}><span className="chipName">{photo.caption || "Photo"}</span><span className="chipQty">Supprimée le {photo.deleted_at ? date.format(new Date(photo.deleted_at)) : ""}</span></div>)}</div>}
          </div>}
        </section>
        {isAdmin && <section className="projectSiteCard projectSuggestionsCard mobAdminOrder10"><div className="projectCardHead"><div><p className="projectEyebrow">ASSISTANCE</p><h2>Recommandations à examiner</h2></div><span>Historisées</span></div><p className="projectHint">L’analyse est volontaire : elle examine les rapports, stocks et photos associées lorsque vous l’autorisez. Les anomalies détectées sont aussi signalées dans la messagerie du chantier.</p>{canOperate && <button type="button" className="projectAiReviewButton" onClick={() => void requestAiReview()} disabled={!online || busy}>{busy ? "Analyse en cours…" : online ? "Analyser le chantier" : "Analyse disponible en ligne"}</button>}<div className="projectSuggestionList">{projectSuggestions.length ? projectSuggestions.map((suggestion) => <article key={suggestion.id} className={`suggestion-${suggestion.status}`}><strong>{suggestion.title}</strong><p>{suggestion.content}</p><small>{suggestion.status === "accepted" ? "Acceptée" : suggestion.status === "rejected" ? "Écartée" : "À décider"}{suggestion.confidence ? ` · confiance ${number(suggestion.confidence)} %` : ""}</small>{suggestion.status === "pending" && canEditOwnCurrentRecord(suggestion) && <div><button type="button" onClick={() => void answerSuggestion(suggestion.id, "accepted", "Acceptée par l’utilisateur")}>Accepter</button><button type="button" className="secondary" onClick={() => void answerSuggestion(suggestion.id, "rejected", "Écartée par l’utilisateur")}>Écarter</button></div>}</article>) : <p className="projectEmptyText">Aucune recommandation à examiner pour ce chantier.</p>}</div></section>}
        {isAdmin && <section className="projectSiteCard projectSuggestionsCard mobAdminOrder1">
          <div className="projectCardHead"><div><p className="projectEyebrow">DEMANDE</p><h2>Matériaux à valider</h2></div><span className={pendingApprovalOrders.length ? "projectAlert" : "projectOk"}>{pendingApprovalOrders.length} en attente</span></div>
          <p className="projectHint">Comparez chaque demande au stock disponible avant de valider l’achat.</p>
          <div className="projectMaterialList">{pendingApprovalOrders.length ? pendingApprovalOrders.map((order) => { const material = projectMaterials.find((item) => item.id === order.material_id); const available = number(material?.on_site_quantity); const purchase = Math.max(0, number(order.quantity) - available); const total = number(order.quantity) * number(order.unit_price); return <article key={order.id}>
            <div><button type="button" className="projectPlainLink" onClick={() => { void markOrderSeen(order); setViewingRequestDetail(order); }}>{order.material_name}</button><small> · {number(order.quantity)} {order.unit} · demandé par {readerName(order.requested_by || "")} · besoin : {order.needed_timing ? TIMING_LABELS[order.needed_timing] : "—"}</small><br /><small>Stock disponible : {available} {order.unit} · à acheter : {purchase} {order.unit} · prix total : {total.toLocaleString("fr-FR")} Ar</small></div>
            <div style={{ display: "flex", gap: "8px" }}>
              <button type="button" disabled={busy} onClick={() => void approveMaterialRequest(order)}>Valider</button>
              <button type="button" className="projectRejectButton" disabled={busy} onClick={() => void rejectMaterialRequest(order)}>Rejeter</button>
            </div>
          </article>; }) : <p className="projectEmptyText">Aucune demande en attente.</p>}</div>
          {viewingRequestDetail && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={() => setViewingRequestDetail(null)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(420px,100%)" }}>
            <h2 className="font-bold text-xl mb-4">{viewingRequestDetail.material_name}</h2>
            <div className="priceDetailGrid" style={{ gridTemplateColumns: "1fr" }}>
              <div className="priceDetailStat"><span>Quantité demandée</span><strong>{number(viewingRequestDetail.quantity)} {viewingRequestDetail.unit}</strong></div>
              <div className="priceDetailStat"><span>Prix unitaire</span><strong>{number(viewingRequestDetail.unit_price).toLocaleString("fr-FR")} Ar</strong></div>
              <div className="priceDetailStat"><span>Prix total</span><strong>{(number(viewingRequestDetail.quantity) * number(viewingRequestDetail.unit_price)).toLocaleString("fr-FR")} Ar</strong></div>
              <div className="priceDetailStat"><span>Demandé par</span><strong>{readerName(viewingRequestDetail.requested_by || "")}</strong></div>
              <div className="priceDetailStat"><span>Besoin</span><strong>{viewingRequestDetail.needed_timing ? TIMING_LABELS[viewingRequestDetail.needed_timing] : "—"}</strong></div>
              <div className="priceDetailStat"><span>Date de demande</span><strong>{viewingRequestDetail.submitted_at ? dateTime.format(new Date(viewingRequestDetail.submitted_at)) : "—"}</strong></div>
            </div>
            <div style={{ display: "flex", gap: "10px", marginTop: "14px", flexWrap: "wrap" }}>
              <button type="button" disabled={busy} onClick={() => { void approveMaterialRequest(viewingRequestDetail); setViewingRequestDetail(null); }}>Valider</button>
              <button type="button" className="projectRejectButton" disabled={busy} onClick={() => { void rejectMaterialRequest(viewingRequestDetail); setViewingRequestDetail(null); }}>Rejeter</button>
              <button type="button" className="ghostButton" onClick={() => setViewingRequestDetail(null)}>Fermer</button>
            </div>
          </div></div>, document.body)}
          <button type="button" className="secondary projectHistoryButton" onClick={() => setViewingAdminOrdersHistory(true)}>Voir l’historique</button>
        </section>}
        {viewingAdminOrdersHistory && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={() => setViewingAdminOrdersHistory(false)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(480px,100%)", display: "flex", flexDirection: "column", maxHeight: "85vh" }}>
          <h2 className="font-bold text-xl mb-4">Historique des demandes de matériaux</h2>
          <div className="projectNoteList projectNoteListScroll" style={{ flex: "1 1 auto", minHeight: 0 }}>{allOrdersHistory.length ? allOrdersHistory.map((order) => <div className="projectTeamMember" key={order.id}><strong>{order.material_name}</strong><span>{number(order.quantity)} {order.unit} · {(number(order.quantity) * number(order.unit_price)).toLocaleString("fr-FR")} Ar · {orderStatusLabel(order)} · demandé par {readerName(order.requested_by || "")}</span><small>Demande : {order.submitted_at ? dateTime.format(new Date(order.submitted_at)) : "—"} · Validation : {order.approved_at ? dateTime.format(new Date(order.approved_at)) : "—"}</small></div>) : <p className="projectEmptyText">Aucune demande dans l’historique.</p>}</div>
          <button type="button" className="ghostButton mt-5" style={{ flex: "0 0 auto" }} onClick={() => setViewingAdminOrdersHistory(false)}>Fermer</button>
        </div></div>, document.body)}
        {!isAdmin && <section className="projectSiteCard projectSuggestionsCard">
          <div className="projectCardHead"><div><p className="projectEyebrow">DEMANDE</p><h2>Matériaux en attente de validation</h2></div><span>{pendingApprovalOrders.length}</span></div>
          <p className="projectHint">Toutes les demandes en attente du chantier, pour éviter qu’un autre poste redemande le même matériau.</p>
          {pendingApprovalOrders.length ? pendingApprovalOrders.map((order) => <div className="projectTeamMember" key={order.id}><strong>{order.material_name}</strong><span>{number(order.quantity)} {order.unit} · demandé par {readerName(order.requested_by || "")} · {orderStatusLabel(order)}</span></div>) : <p className="projectEmptyText">Aucune demande en attente.</p>}
          <button type="button" className="secondary projectHistoryButton" onClick={() => setViewingMyRequestsHistory(true)}>Voir l’historique</button>
        </section>}
        {viewingMyRequestsHistory && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={() => setViewingMyRequestsHistory(false)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(480px,100%)", display: "flex", flexDirection: "column", maxHeight: "85vh" }}>
          <h2 className="font-bold text-xl mb-4">Historique de mes demandes</h2>
          <div className="projectNoteList projectNoteListScroll" style={{ flex: "1 1 auto", minHeight: 0 }}>{myMaterialOrdersHistory.length ? myMaterialOrdersHistory.map((order) => <div className="projectTeamMember" key={order.id}><strong>{order.material_name}</strong><span>{number(order.quantity)} {order.unit} · {(number(order.quantity) * number(order.unit_price)).toLocaleString("fr-FR")} Ar · {orderStatusLabel(order)}</span><small>Demande : {order.submitted_at ? dateTime.format(new Date(order.submitted_at)) : "—"} · Validation : {order.approved_at ? dateTime.format(new Date(order.approved_at)) : "—"}</small></div>) : <p className="projectEmptyText">Aucune demande dans l’historique.</p>}</div>
          <button type="button" className="ghostButton mt-5" style={{ flex: "0 0 auto" }} onClick={() => setViewingMyRequestsHistory(false)}>Fermer</button>
        </div></div>, document.body)}
        <section className={`projectSiteCard projectNotesCard${isAdmin ? " mobAdminOrder8" : ""}`} id="messagingCard"><div className="projectCardHead"><div><p className="projectEyebrow">MESSAGERIE INTERNE</p><h2>Remarques et notifications</h2></div><span>{projectNotes.length} message(s)</span></div><p className="projectHint">Les remarques permettent aux niveaux supérieurs de signaler un désaccord sans modifier la saisie d’origine. Elles restent consultables hors ligne après réception.</p><div className="projectNoteSettings"><button type="button" className="secondary" onClick={() => void toggleSoundAlerts()}>{soundEnabled ? "Son des alertes activé" : "Activer le son des alertes"}</button><small>Erreur grave : rouge + signal sonore · Point à contrôler : orange · Information : neutre.</small></div><form className="projectNoteForm" onSubmit={(event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const [entity_type, entity_id] = String(form.get("target") || "").split(":"); if (!entity_type || !entity_id) { setMessage("Choisissez la saisie concernée par la remarque."); return; } void insert("project_record_notes", { entity_type, entity_id, severity: String(form.get("severity") || "review"), title: String(form.get("title") || "Remarque de suivi"), content: String(form.get("content") || "") }, (row) => setRecordNotes((rows) => [row, ...rows])); event.currentTarget.reset(); }}><select name="severity" defaultValue="review"><option value="urgent">Erreur grave</option><option value="review">Point à contrôler</option><option value="info">Information ou précision</option></select><select name="target" defaultValue="" required><option value="" disabled>Saisie concernée</option>{noteTargets.map((target) => <option key={`${target.type}-${target.id}`} value={`${target.type}:${target.id}`}>{target.label}</option>)}</select><input name="title" required placeholder="Objet de la remarque" /><textarea name="content" required placeholder="Décrivez le problème, le contrôle à faire ou la correction proposée." /><button disabled={busy || !noteTargets.length}>{noteTargets.length ? "Envoyer la remarque" : "Ajoutez d’abord une saisie"}</button></form><div className="projectNoteChipList">{projectNotes.length ? projectNotes.map((note) => { const bright = noteOriginalUnread(note) || noteReplyUnread(note); const notif = noteReplyUnread(note) && !noteOriginalUnread(note); return <div key={note.id} className={`projectNoteRow note-${note.severity}${bright ? "" : " isReadNote"}`} onClick={() => { setViewingNoteDetail(note); void markNoteRead(note); }}><span>{noteSeverityLabel(note.severity)}{notif && <span className="noteNotifDot" />}</span><span>{dateTime.format(new Date(note.created_at))}</span></div>; }) : <p className="projectEmptyText">Aucune remarque pour ce chantier.</p>}</div><button type="button" className="secondary projectHistoryButton" onClick={() => setViewingNotes(true)}>Voir l’historique</button></section>
        {viewingNotes && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={() => setViewingNotes(false)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(480px,100%)", display: "flex", flexDirection: "column", maxHeight: "85vh" }}>
          <h2 className="font-bold text-xl mb-4" style={{ flex: "0 0 auto" }}>Messagerie — historique complet</h2>
          <div className="projectNoteChipList" style={{ flex: "1 1 auto", minHeight: 0, maxHeight: "none" }}>{allProjectNotes.length ? allProjectNotes.map((note) => { const bright = noteOriginalUnread(note) || noteReplyUnread(note); const notif = noteReplyUnread(note) && !noteOriginalUnread(note); return <div key={note.id} className={`projectNoteRow note-${note.severity}${bright ? "" : " isReadNote"}`} onClick={() => { setViewingNoteDetail(note); void markNoteRead(note); }}><span>{noteSeverityLabel(note.severity)}{notif && <span className="noteNotifDot" />}</span><span>{dateTime.format(new Date(note.created_at))}</span></div>; }) : <p className="projectEmptyText">Aucune remarque pour ce chantier.</p>}</div>
          <button type="button" className="ghostButton mt-5" style={{ flex: "0 0 auto" }} onClick={() => setViewingNotes(false)}>Fermer</button>
        </div></div>, document.body)}
        {viewingNoteDetail && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={() => setViewingNoteDetail(null)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(520px,100%)", display: "flex", flexDirection: "column", maxHeight: "85vh" }}>
          <h2 className="font-bold text-xl mb-4" style={{ flex: "0 0 auto" }}>{noteSeverityLabel(viewingNoteDetail.severity)} · {dateTime.format(new Date(viewingNoteDetail.created_at))}</h2>
          <div style={{ flex: "1 1 auto", minHeight: 0, overflowY: "auto", paddingRight: "4px" }}>
            <h3 className="font-bold">{viewingNoteDetail.title}</h3>
            <p className="projectHint">{viewingNoteDetail.content}</p>
            <small style={{ display: "block", marginTop: "6px", color: "#587062" }}>Envoyé par {readerName(viewingNoteDetail.created_by || "")}</small>
            <hr style={{ margin: "14px 0", border: 0, borderTop: "1px solid #e1ece4" }} />
            <h3 className="font-bold">Réponse</h3>
            {viewingNoteDetail.reply_content ? <div className="projectNoteReplyBlock"><strong>{replySeverityLabel(viewingNoteDetail.reply_severity)}</strong><p>{viewingNoteDetail.reply_content}</p><small>{readerName(viewingNoteDetail.replied_by || "")} · {viewingNoteDetail.replied_at ? dateTime.format(new Date(viewingNoteDetail.replied_at)) : ""}</small></div> : <p className="projectEmptyText">Aucune réponse pour l’instant.</p>}
            <h3 className="mt-3 font-bold">Répondre</h3>
            <div className="projectChipChoices">{([["urgent", "Erreur grave"], ["review", "Point à contrôler"], ["confirmation", "Confirmation"]] as const).map(([value, label]) => <button type="button" key={value} className={replyDraft.severity === value ? "isSelected" : ""} onClick={() => setReplyDraft((draft) => ({ ...draft, severity: value }))}>{label}</button>)}</div>
            <textarea className="w-full border p-3 rounded-lg mt-2" rows={3} value={replyDraft.content} onChange={(event) => setReplyDraft((draft) => ({ ...draft, content: event.target.value }))} placeholder="Votre réponse à l’équipe" />
          </div>
          <div style={{ display: "flex", gap: "10px", marginTop: "14px", flex: "0 0 auto" }}>
            <button type="button" className="button" onClick={() => void submitNoteReply(viewingNoteDetail)}>Valider la réponse</button>
            <button type="button" className="ghostButton" onClick={() => setViewingNoteDetail(null)}>Fermer</button>
          </div>
        </div></div>, document.body)}
        {(isAdmin || canUploadPurchaseEvidence) && <section className={`projectSiteCard projectExpenseWorkflow${isAdmin ? " mobAdminOrder2" : ""}`}>
          <div className="projectCardHead"><div><p className="projectEyebrow">ACHATS</p><h2>Matériaux validés</h2></div><span className={validatedOrdersToPurchase.length ? "projectAlert" : "projectOk"}>{validatedOrdersToPurchase.length} validé(s) à acheter</span></div>
          <p className="projectHint">Dès qu’une demande est validée, elle apparaît ici : achetez le matériau, prenez-en la photo, et le stock ainsi que les dépenses se mettent à jour automatiquement.</p>
          <div className="projectNoteList">{validatedOrdersToPurchase.length ? validatedOrdersToPurchase.map((order) => <article key={order.id} className="projectTeamMember" style={{ cursor: "pointer" }} onClick={() => { setViewingOrder(order); setSelectedPurchaseOffer(null); setForceRegionChoice(false); }}><strong>{order.material_name}</strong><span>{number(order.quantity)} {order.unit} · {(number(order.quantity) * number(order.unit_price)).toLocaleString("fr-FR")} Ar</span></article>) : <p className="projectEmptyText">Aucun matériau en attente d’achat.</p>}</div>
          <button type="button" className="secondary projectHistoryButton" onClick={() => setViewingAchats(true)}>Voir l’historique</button>
        </section>}
        {canOperate && <section className={`projectSiteCard projectMiscExpenseCard${isAdmin ? " mobAdminOrder12" : ""}`}>
          <div className="projectCardHead"><div><p className="projectEyebrow">IMPRÉVU</p><h2>Dépenses imprévues</h2></div></div>
          <p className="projectHint">Cadeaux ou toute dépense hors matériau/salaire. Envoyée directement au compte dépense générale après confirmation.</p>
          {addingMiscExpense ? <>
            <div className="projectMaterialForm">
              <input placeholder="Nom du bénéficiaire ou organisme" value={miscExpenseDraft.recipient} onChange={(event) => setMiscExpenseDraft((draft) => ({ ...draft, recipient: event.target.value }))} />
              <input type="number" min="0" step="any" placeholder="Montant (Ar)" value={miscExpenseDraft.amount} onChange={(event) => setMiscExpenseDraft((draft) => ({ ...draft, amount: event.target.value }))} />
              <input placeholder="Note (facultatif)" value={miscExpenseDraft.note} onChange={(event) => setMiscExpenseDraft((draft) => ({ ...draft, note: event.target.value }))} />
              <button type="button" disabled={busy} onClick={() => setConfirmingMiscExpense(true)}>Valider</button>
            </div>
            <button type="button" className="ghostButton mt-2" onClick={() => { setAddingMiscExpense(false); setMiscExpenseStatus(null); }}>Annuler</button>
          </> : <button type="button" onClick={() => setAddingMiscExpense(true)}>+ Ajouter une dépense imprévue</button>}
          {miscExpenseStatus && <p className={`projectAccessStatus ${miscExpenseStatus.kind}`} role="status" aria-live="polite">{miscExpenseStatus.text}</p>}
        </section>}
        {confirmingMiscExpense && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={() => setConfirmingMiscExpense(false)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(420px,100%)" }}>
          <h2 className="font-bold text-xl mb-4">Confirmer la dépense</h2>
          <p className="projectHint">{miscExpenseDraft.recipient} — {number(miscExpenseDraft.amount).toLocaleString("fr-FR")} Ar. Envoyée directement au compte dépense générale, aucune validation supplémentaire.</p>
          <div style={{ display: "flex", gap: "10px", marginTop: "14px" }}>
            <button type="button" disabled={busy} onClick={() => void submitMiscExpense()}>Confirmer</button>
            <button type="button" className="ghostButton" onClick={() => setConfirmingMiscExpense(false)}>Annuler</button>
          </div>
        </div></div>, document.body)}
        {viewingOrder && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={() => { setViewingOrder(null); setSelectedTransportMode(null); setSelectedTransportPrice(null); setSelectedPurchaseOffer(null); setForceRegionChoice(false); }}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(480px,100%)" }}>
          <h2 className="font-bold text-xl mb-4">{viewingOrder.material_name}</h2>
          <p className="projectHint">{number(viewingOrder.quantity)} {viewingOrder.unit} · {(number(viewingOrder.quantity) * number(viewingOrder.unit_price)).toLocaleString("fr-FR")} Ar · demandé par {readerName(viewingOrder.requested_by || "")}</p>
          {viewingOrder.status === "covered_by_stock" ? <p className="projectOk" style={{ padding: "10px", borderRadius: "10px" }}>Couvert par le stock disponible — aucun achat nécessaire.</p> : viewingOrderNeedsRegionChoice ? <>
            {/* Contrairement au devis (toujours le moins cher automatiquement),
                ce matériau a des offres dans plusieurs régions : on demande
                juste laquelle, sans détailler chaque fournisseur. */}
            <p className="projectHint">Ce matériau a des offres dans plusieurs régions — laquelle a été utilisée ?</p>
            <div className="projectChipChoices">
              {viewingOrderRegionGroups.map((group) => (
                <button type="button" key={group.key} onClick={() => { setSelectedPurchaseOffer(cheapestInRegionGroup(group)); setForceRegionChoice(false); }}>{group.label}</button>
              ))}
            </div>
            <button type="button" className="ghostButton mt-3" onClick={() => { setViewingOrder(null); setPurchaseStatus(null); }}>Annuler</button>
          </> : <form className="projectPurchaseForm" onSubmit={(event) => { void uploadPurchaseEvidence(event, viewingOrder).then((success) => { if (success) setViewingOrder(null); }); }}>
            {matchedRegionGroup && !forceRegionChoice && !selectedPurchaseOffer && <p className="projectHint">Région la plus proche du chantier : <strong>{matchedRegionGroup.label}</strong> — <button type="button" onClick={(event) => { event.preventDefault(); setForceRegionChoice(true); }} style={{ border: "none", background: "none", padding: 0, minHeight: 0, color: "#0f6b34", fontWeight: 800, textDecoration: "underline", cursor: "pointer" }}>changer</button></p>}
            {selectedPurchaseOffer && viewingOrderRegionGroups.length > 1 && <p className="projectHint">Région choisie : <strong>{selectedPurchaseOffer.region || selectedPurchaseOffer.ville || "Non précisé"}</strong> — <button type="button" onClick={(event) => { event.preventDefault(); setSelectedPurchaseOffer(null); setForceRegionChoice(true); }} style={{ border: "none", background: "none", padding: 0, minHeight: 0, color: "#0f6b34", fontWeight: 800, textDecoration: "underline", cursor: "pointer" }}>changer</button></p>}
            <input name="purchased_quantity" type="number" min="0.001" step="any" required defaultValue={number(viewingOrder.quantity_to_purchase || viewingOrder.quantity)} placeholder="Quantité achetée" />
            <input name="unit_price" type="number" min="0" step="any" required defaultValue={effectiveOffer ? number(effectiveOffer.prix) : number(viewingOrder.unit_price)} placeholder="Prix payé (Ar)" />
            <label className="projectPhotoButton">📷 Photo de l’achat<input name="purchase_photo" type="file" accept="image/*" capture="environment" style={{ display: "none" }} /></label>
            <button type="button" className="secondary" onClick={(event) => { event.preventDefault(); setTransportChoiceOpen(true); }}>🚚 Transport{selectedTransportMode ? ` — ${TRANSPORT_MODE_LABELS[selectedTransportMode]}${selectedTransportPrice ? ` (${selectedTransportPrice.toLocaleString("fr-FR")} Ar)` : ""}` : ""}</button>
            <button disabled={busy || !canUploadPurchaseEvidence}>Valider l’achat</button>
          </form>}
          {purchaseStatus && <p className={`projectAccessStatus ${purchaseStatus.kind}`} role="status" aria-live="polite">{purchaseStatus.text}</p>}
          {!viewingOrderNeedsRegionChoice && <button type="button" className="ghostButton mt-3" onClick={() => { setViewingOrder(null); setPurchaseStatus(null); setSelectedTransportMode(null); setSelectedTransportPrice(null); setSelectedPurchaseOffer(null); setForceRegionChoice(false); }}>Fermer</button>}
        </div></div>, document.body)}
        {transportChoiceOpen && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={() => setTransportChoiceOpen(false)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(360px,100%)" }}>
          <h2 className="font-bold text-xl mb-4">Moyen de transport</h2>
          <div className="projectChipChoices">{(["homme", "charrette", "camionnette", "camion", "autre"] as const).map((mode) => <button type="button" key={mode} onClick={() => { setSelectedTransportMode(mode); setTransportChoiceOpen(false); setTransportPriceDraft(selectedTransportPrice ? String(selectedTransportPrice) : ""); setTransportPriceOpen(true); }}>{TRANSPORT_MODE_LABELS[mode]}</button>)}</div>
          <button type="button" className="ghostButton mt-3" onClick={() => setTransportChoiceOpen(false)}>Annuler</button>
        </div></div>, document.body)}
        {transportPriceOpen && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={() => { setTransportPriceOpen(false); setSelectedTransportMode(null); }}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(360px,100%)" }}>
          <h2 className="font-bold text-xl mb-4">Prix du transport — {TRANSPORT_MODE_LABELS[selectedTransportMode || "autre"]}</h2>
          <input type="number" min="0" step="any" autoFocus placeholder="Prix payé (Ar)" value={transportPriceDraft} onChange={(event) => setTransportPriceDraft(event.target.value)} />
          <div style={{ display: "flex", gap: "10px", marginTop: "14px" }}>
            <button type="button" disabled={!(number(transportPriceDraft) > 0)} onClick={() => { setSelectedTransportPrice(number(transportPriceDraft)); setTransportPriceOpen(false); }}>Valider</button>
            <button type="button" className="ghostButton" onClick={() => { setTransportPriceOpen(false); setSelectedTransportMode(null); setTransportPriceDraft(""); }}>Annuler</button>
          </div>
        </div></div>, document.body)}
        {viewingAchats && typeof document !== "undefined" && createPortal(
<div className="modalBackdrop" onClick={() => setViewingAchats(false)}><div className="modal" onClick={(event) => event.stopPropagation()} style={{ width: "min(480px,100%)", display: "flex", flexDirection: "column", maxHeight: "85vh" }}>
            <h2 className="font-bold text-xl mb-4">Historique des achats</h2>
            <div className="projectNoteList projectNoteListScroll" style={{ flex: "1 1 auto", minHeight: 0 }}>
              {paidOrdersHistory.length ? paidOrdersHistory.map((order) => <div className="projectTeamMember" key={order.id}><strong>{order.material_name}</strong><div className="flex flex-wrap items-center justify-end gap-2"><span>Demande : {order.submitted_at ? dateTime.format(new Date(order.submitted_at)) : "—"} · Validation : {order.approved_at ? dateTime.format(new Date(order.approved_at)) : "—"} · Achat : {order.paid_at ? dateTime.format(new Date(order.paid_at)) : "—"}{order.purchase_photo_path && <button type="button" className="ghostButton" style={{ marginLeft: "8px" }} onClick={() => void openPhoto({ id: order.id, project_id: selectedId || "", storage_path: order.purchase_photo_path!, caption: order.purchase_photo_caption || null, photo_type: "delivery", captured_at: order.paid_at || order.approved_at || new Date().toISOString(), created_at: order.paid_at || order.approved_at || new Date().toISOString() } as SitePhoto)}>Photo</button>}</span>{isAdmin && <button type="button" className="rounded-lg border border-red-700 bg-white px-2 py-1 text-xs font-bold text-red-700 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50" disabled={busy} onClick={() => void adminDeleteMaterialOrder(order)}>Supprimer</button>}</div></div>) : <p className="projectEmptyText">Aucun achat payé pour l’instant.</p>}
            </div>
            <button type="button" className="ghostButton mt-5" style={{ flex: "0 0 auto" }} onClick={() => setViewingAchats(false)}>Fermer</button>
        </div></div>, document.body)}
      </main>
    </>}
  </div>;
}
