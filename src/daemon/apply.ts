import { Git } from "../sandbox/git.js";
import { PolishError } from "../shared/errors.js";

export interface ApplyRunBranchInput {
  projectPath: string;
  runBranch: string;
  expectedTargetBranch?: string;
}

/**
 * The sole user-checkout mutation in the facade. Run completion never calls this function.
 * Applying requires the original target branch, a clean checkout, and a fast-forward.
 */
export async function applyRunBranch(input: ApplyRunBranchInput): Promise<{ branch: string; commit: string }> {
  const git = new Git(input.projectPath);
  const branch = await git.out(["branch", "--show-current"]);
  if (branch === "") throw new PolishError("CONFLICT", "cannot apply to a detached HEAD");
  if (input.expectedTargetBranch !== undefined && branch !== input.expectedTargetBranch) {
    throw new PolishError(
      "CONFLICT",
      `run was started from ${input.expectedTargetBranch}; current branch is ${branch}`,
    );
  }
  if (!(await git.isClean())) {
    throw new PolishError("CONFLICT", "target repository has uncommitted changes");
  }
  if (!(await git.branchExists(input.runBranch))) {
    throw new PolishError("NOT_FOUND", `run branch ${input.runBranch} does not exist`);
  }
  const before = await git.revParse("HEAD");
  const target = await git.revParse(input.runBranch);
  if (before !== target) {
    const ancestor = await git.run(["merge-base", "--is-ancestor", before, target], { allowFailure: true });
    if (ancestor.exitCode !== 0) {
      throw new PolishError("CONFLICT", `${input.runBranch} cannot fast-forward ${branch}`);
    }
    await git.run(["merge", "--ff-only", "--no-edit", input.runBranch]);
  }
  return { branch, commit: target };
}
