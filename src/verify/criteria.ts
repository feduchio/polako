export function decomposeCriteria(
  task: string | undefined,
  acceptance?: readonly string[],
  configured?: readonly string[],
): string[] {
  const fromTask = splitCriteria(task);
  const fromAcceptance = (acceptance ?? [])
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const merged = [...fromTask, ...fromAcceptance].slice(0, 8);
  if (merged.length > 0) return merged;
  const defaults = (configured ?? []).map((item) => item.trim()).filter((item) => item.length > 0).slice(0, 8);
  return defaults.length > 0 ? defaults : ["correctness", "regression safety", "simplicity"];
}

function splitCriteria(task: string | undefined): string[] {
  if (task === undefined || task.trim() === "") return [];
  return task
    .split(/\n|[.;]\s+/)
    .map((criterion) => criterion.trim())
    .filter((criterion) => criterion.length > 0)
    .slice(0, 8);
}
