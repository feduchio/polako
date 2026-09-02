import type { z } from "zod";
import { AcceptanceArtifactSchema, type AcceptanceArtifact } from "../domain/acceptance.js";
import { CandidateSchema, type Candidate } from "../domain/candidate.js";
import { BaselineSnapshotSchema, type BaselineSnapshot } from "../domain/checks.js";
import { CheckpointSchema, type Checkpoint } from "../domain/checkpoint.js";
import { CleanRoundSchema, type CleanRound } from "../domain/convergence.js";
import { FactSchema, type Fact } from "../domain/fact.js";
import { FindingSchema, FindingValidationSchema, type Finding, type FindingValidation } from "../domain/finding.js";
import { JobSchema, type Job } from "../domain/job.js";
import { MissionInterpretationSchema, MissionSchema, type Mission, type MissionInterpretation } from "../domain/mission.js";
import { RunSchema, type Run } from "../domain/run.js";
import { TaskSchema, type Task } from "../domain/task.js";
import type { Db } from "./db.js";
import type { ProjectedTable } from "./projections.js";

/**
 * Read-side access to projections. Writes go through the EventLog (events carry snapshots);
 * repositories never mutate rows themselves. This keeps "replay == live" true by construction.
 */
class ReadRepo<T> {
  constructor(
    protected readonly db: Db,
    protected readonly table: ProjectedTable,
    private readonly schema: z.ZodType<T>,
  ) {}

  get(id: string): T | null {
    const row = this.db.prepare(`SELECT json FROM ${this.table} WHERE id = ?`).get(id) as { json: string } | undefined;
    return row ? this.parse(row.json) : null;
  }

  protected query(where: string, params: (string | number | null)[], orderBy = "rowid"): T[] {
    const rows = this.db.prepare(`SELECT json FROM ${this.table} WHERE ${where} ORDER BY ${orderBy}`).all(...params) as { json: string }[];
    return rows.map((r) => this.parse(r.json));
  }

  protected parse(json: string): T {
    return this.schema.parse(JSON.parse(json));
  }
}

class RunRepo extends ReadRepo<Run> {
  listActive(): Run[] {
    return this.query("phase NOT IN ('DONE','NEEDS_HUMAN','FAILED') AND control NOT IN ('STOPPED','KILLED')", []);
  }
  listAll(): Run[] {
    return this.query("1 = 1", [], "updated_at DESC");
  }
}

class ByRunRepo<T> extends ReadRepo<T> {
  listByRun(runId: string): T[] {
    return this.query("run_id = ?", [runId]);
  }
}

class TaskRepo extends ByRunRepo<Task> {
  listByState(runId: string, states: readonly Task["state"][]): Task[] {
    if (states.length === 0) return [];
    return this.query(`run_id = ? AND state IN (${states.map(() => "?").join(",")})`, [runId, ...states]);
  }
}

class CandidateRepo extends ByRunRepo<Candidate> {
  listByTask(taskId: string): Candidate[] {
    return this.query("task_id = ?", [taskId]);
  }
}

class CheckpointRepo extends ByRunRepo<Checkpoint> {
  latest(runId: string): Checkpoint | null {
    return this.query("run_id = ?", [runId], "seq DESC")[0] ?? null;
  }
  byCommit(runId: string, commitHash: string): Checkpoint | null {
    return this.query("run_id = ? AND commit_hash = ?", [runId, commitHash], "seq DESC")[0] ?? null;
  }
}

class FindingRepo extends ByRunRepo<Finding> {
  listByStatus(runId: string, statuses: readonly Finding["status"][]): Finding[] {
    if (statuses.length === 0) return [];
    return this.query(`run_id = ? AND status IN (${statuses.map(() => "?").join(",")})`, [runId, ...statuses]);
  }
  byFingerprint(runId: string, fingerprint: string): Finding[] {
    return this.query("run_id = ? AND fingerprint = ?", [runId, fingerprint]);
  }
  openForCheckpoint(runId: string, checkpointHash: string): Finding[] {
    return this.query("run_id = ? AND checkpoint_hash = ? AND status IN ('VALID','VALIDATING','UNCERTAIN')", [runId, checkpointHash]);
  }
}

class ValidationRepo extends ByRunRepo<FindingValidation> {
  listByFinding(findingId: string): FindingValidation[] {
    return this.query("finding_id = ?", [findingId]);
  }
}

class CleanRoundRepo extends ByRunRepo<CleanRound> {
  forCheckpoint(runId: string, checkpointHash: string): CleanRound[] {
    return this.query("run_id = ? AND checkpoint_hash = ?", [runId, checkpointHash], "round_index ASC");
  }
}

class FactRepo extends ByRunRepo<Fact> {
  listCurrent(runId: string): Fact[] {
    return this.query("run_id = ? AND superseded_by IS NULL", [runId]);
  }
}

class AcceptanceRepo extends ByRunRepo<AcceptanceArtifact> {
  forTask(runId: string, taskId: string | null): AcceptanceArtifact[] {
    return taskId === null
      ? this.query("run_id = ? AND task_id IS NULL", [runId])
      : this.query("run_id = ? AND (task_id IS NULL OR task_id = ?)", [runId, taskId]);
  }
}

class JobRepo extends ByRunRepo<Job> {
  listByState(states: readonly Job["state"][], runId?: string): Job[] {
    if (states.length === 0) return [];
    const inList = states.map(() => "?").join(",");
    return runId === undefined
      ? this.query(`state IN (${inList})`, [...states], "priority DESC, created_at ASC")
      : this.query(`run_id = ? AND state IN (${inList})`, [runId, ...states], "priority DESC, created_at ASC");
  }
}

class InterpretationRepo extends ReadRepo<MissionInterpretation> {
  latestForMission(missionId: string): MissionInterpretation | null {
    return this.query("mission_id = ?", [missionId], "version DESC")[0] ?? null;
  }
}

export interface Repositories {
  runs: RunRepo;
  missions: ReadRepo<Mission>;
  interpretations: InterpretationRepo;
  baselines: ByRunRepo<BaselineSnapshot>;
  tasks: TaskRepo;
  candidates: CandidateRepo;
  checkpoints: CheckpointRepo;
  findings: FindingRepo;
  validations: ValidationRepo;
  cleanRounds: CleanRoundRepo;
  facts: FactRepo;
  acceptance: AcceptanceRepo;
  jobs: JobRepo;
}

export function createRepositories(db: Db): Repositories {
  return {
    runs: new RunRepo(db, "runs", RunSchema),
    missions: new ReadRepo(db, "missions", MissionSchema),
    interpretations: new InterpretationRepo(db, "interpretations", MissionInterpretationSchema),
    baselines: new ByRunRepo(db, "baselines", BaselineSnapshotSchema),
    tasks: new TaskRepo(db, "tasks", TaskSchema),
    candidates: new CandidateRepo(db, "candidates", CandidateSchema),
    checkpoints: new CheckpointRepo(db, "checkpoints", CheckpointSchema),
    findings: new FindingRepo(db, "findings", FindingSchema),
    validations: new ValidationRepo(db, "finding_validations", FindingValidationSchema),
    cleanRounds: new CleanRoundRepo(db, "clean_rounds", CleanRoundSchema),
    facts: new FactRepo(db, "facts", FactSchema),
    acceptance: new AcceptanceRepo(db, "acceptance_artifacts", AcceptanceArtifactSchema),
    jobs: new JobRepo(db, "jobs", JobSchema),
  };
}
