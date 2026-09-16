type DaoTask = {
  title?: unknown;
  designation?: unknown;
  description?: unknown;
  name?: unknown;
  duration_days?: unknown;
  duration?: unknown;
  days?: unknown;
  sequence?: unknown;
  order?: unknown;
  source_reference?: unknown;
  source?: unknown;
};

type DaoAnalysis = {
  execution_plan?: DaoTask[];
  site_execution_details?: DaoTask[];
};

export type DaoProjectTask = {
  organization_id: string;
  project_id: string;
  dao_sequence: number;
  title: string;
  source_reference: string;
  is_dao_task: true;
  notes: string | null;
};

/** Converts the planning extracted from a DAO into stable chantier tasks. */
export function daoTasksFromAnalysis(
  rawAnalysis: unknown,
  organizationId: string,
  projectId: string,
): DaoProjectTask[] {
  const analysis = (rawAnalysis ?? {}) as DaoAnalysis;
  const convert = (candidateTasks: DaoTask[] | undefined) => {
    const usedSequences = new Set<number>();
    const sourceTasks = Array.isArray(candidateTasks) ? candidateTasks : [];

    return sourceTasks.flatMap((task, index) => {
      const title = String(
        task.title ?? task.designation ?? task.description ?? task.name ?? "",
      ).trim();
      if (!title) return [];

      const candidate = Number(task.sequence ?? task.order);
      let daoSequence = Number.isFinite(candidate) && candidate > 0
        ? Math.trunc(candidate)
        : index + 1;
      while (usedSequences.has(daoSequence)) daoSequence += 1;
      usedSequences.add(daoSequence);

      const duration = Number(task.duration_days ?? task.duration ?? task.days);
      return [{
        organization_id: organizationId,
        project_id: projectId,
        dao_sequence: daoSequence,
        title,
        source_reference: String(task.source_reference ?? task.source ?? "Planning du DAO").trim() || "Planning du DAO",
        is_dao_task: true as const,
        notes: Number.isFinite(duration) && duration > 0
          ? `Durée indicative DAO : ${duration} jour(s).`
          : null,
      }];
    });
  };

  // Certaines anciennes analyses ont un execution_plan présent mais incomplet.
  // Dans ce cas, la page affiche déjà site_execution_details : il doit aussi pouvoir être importé.
  const executionPlanTasks = convert(analysis.execution_plan);
  return executionPlanTasks.length
    ? executionPlanTasks
    : convert(analysis.site_execution_details);
}
