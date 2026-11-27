// What every group of routes is given by app.ts.
import type { FastifyReply, FastifyRequest } from "fastify";
import type { Api } from "../api.js";
import type { Database } from "../db.js";
import type { Executor } from "../executor.js";
import type { ProviderRegistry } from "../providers.js";
import type { Runner } from "../capability-runner.js";

export type RouteContext = {
  api: Api;
  db: Database;
  executor: () => Executor;
  providers: () => ProviderRegistry;
  runner: () => Runner;
  /** A JSON body the console polls for, not sent again while it is the same. */
  unchangedOr: (request: FastifyRequest, reply: FastifyReply, body: string) => FastifyReply;
  /** An engineer action, its refusal a 409. */
  engineerAction: <T>(action: () => T | Promise<T>) => Promise<T>;
};
