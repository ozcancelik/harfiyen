// Long work runs as a job: models share buffers, so one job at a time, in the order asked.
// A tool call waits for its job (reporting progress) or returns the id to poll with job_status.

import { AsyncLocalStorage } from "node:async_hooks";

export type JobState = "queued" | "running" | "done" | "error" | "cancelled";

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

export const CANCELLED = "İptal edildi.";

const jobs = new Map<string, Job>();
const controllers = new Map<string, AbortController>();
const activeSignal = new AsyncLocalStorage<AbortSignal>();
let chain: Promise<unknown> = Promise.resolve();
let counter = 0;

/** The AbortSignal of the job running in the current async call chain, if any. */
export const signal = () => activeSignal.getStore();

export function throwIfCancelled() {
  if (signal()?.aborted) throw new Error(CANCELLED);
}

export function start(tool: string, work: (report: Report) => Promise<string>, onProgress?: (job: Job) => void): { job: Job; done: Promise<Job> } {
  const job: Job = { id: `j${++counter}`, tool, state: "queued", progress: 0, message: "sırada", started: Date.now() };
  const ctrl = new AbortController();
  jobs.set(job.id, job);
  controllers.set(job.id, ctrl);
  const done = chain.then(async () => {
    if (ctrl.signal.aborted) {
      controllers.delete(job.id);
      return job;
    }
    job.state = "running";
    job.message = "başladı";
    try {
      job.result = await activeSignal.run(ctrl.signal, () =>
        work((share, message) => {
          if (ctrl.signal.aborted) throw new Error(CANCELLED);
          job.progress = share;
          if (message) job.message = message;
          onProgress?.(job);
        }),
      );
      job.state = "done";
      job.progress = 1;
    } catch (e) {
      if (ctrl.signal.aborted) {
        job.state = "cancelled";
        job.message = "iptal edildi";
        job.error = undefined;
      } else {
        job.state = "error";
        job.error = e instanceof Error ? e.message : String(e);
      }
    } finally {
      controllers.delete(job.id);
    }
    return job;
  });
  chain = done;
  return { job, done };
}

/** Cancels the given job, or the running / latest queued one when `id` is omitted. */
export function cancel(id?: string): Job {
  const job = id
    ? jobs.get(id)
    : ([...jobs.values()].find((j) => j.state === "running") ?? [...jobs.values()].reverse().find((j) => j.state === "queued"));
  if (!job) throw new Error(id ? `"${id}" kimlikli iş yok.` : "Çalışan ya da sırada bekleyen bir iş yok.");
  if (job.state === "running" || job.state === "queued") {
    job.state = "cancelled";
    job.message = "iptal edildi";
    controllers.get(job.id)?.abort();
  }
  return job;
}

export const get = (id: string) => jobs.get(id);
export const list = () => [...jobs.values()].reverse();

export const describe = (j: Job) =>
  `${j.id} (${j.tool}): ${j.state}${j.state === "running" || j.state === "queued" ? ` %${Math.round(j.progress * 100)} · ${j.message}` : ""}` +
  `${j.state === "error" ? ` · ${j.error}` : ""}${j.state === "done" ? `\n${j.result}` : ""}`;
