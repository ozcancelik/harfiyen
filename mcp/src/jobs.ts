// Long work runs as a job: models share buffers, so one job at a time, in the order asked.
// A tool call waits for its job (reporting progress) or returns the id to poll with job_status.

export type JobState = "queued" | "running" | "done" | "error";

export interface Job {
  id: string;
  tool: string;
  state: JobState;
  /** 0..1 */
  progress: number;
  message: string;
  result?: string;
  error?: string;
  started: number;
}

export type Report = (share: number, message?: string) => void;

const jobs = new Map<string, Job>();
let chain: Promise<unknown> = Promise.resolve();
let counter = 0;

export function start(tool: string, work: (report: Report) => Promise<string>, onProgress?: (job: Job) => void): { job: Job; done: Promise<Job> } {
  const job: Job = { id: `j${++counter}`, tool, state: "queued", progress: 0, message: "sırada", started: Date.now() };
  jobs.set(job.id, job);
  const done = chain.then(async () => {
    job.state = "running";
    job.message = "başladı";
    try {
      job.result = await work((share, message) => {
        job.progress = share;
        if (message) job.message = message;
        onProgress?.(job);
      });
      job.state = "done";
      job.progress = 1;
    } catch (e) {
      job.state = "error";
      job.error = e instanceof Error ? e.message : String(e);
    }
    return job;
  });
  chain = done;
  return { job, done };
}

export const get = (id: string) => jobs.get(id);

export const describe = (j: Job) =>
  `${j.id} (${j.tool}): ${j.state}${j.state === "running" || j.state === "queued" ? ` %${Math.round(j.progress * 100)} · ${j.message}` : ""}` +
  `${j.state === "error" ? ` · ${j.error}` : ""}${j.state === "done" ? `\n${j.result}` : ""}`;
