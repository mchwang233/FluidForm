// The API's projects routes (app.ts builds the app and adds them).
import { HttpError } from "../api.js";
import { discoverProjects, inspectProject, NativePickerError, nativePickDirectory, nativePickerStatus, ProjectDirError } from "../projects.js";
import type { FastifyInstance } from "fastify";
import { Query, queryBool, queryText } from "./common.js";
import type { RouteContext } from "./context.js";

export function projectsRoutes(app: FastifyInstance, { api }: RouteContext): void {
  // ---- Project folders ----

  app.get("/api/projects/discover", async (request) => api.discover(queryBool(request.query as Query, "refresh", false), () => discoverProjects()));

  app.get("/api/projects/inspect", async (request) => {
    try {
      return inspectProject(queryText(request.query as Query, "path"));
    } catch (error) {
      if (error instanceof ProjectDirError) throw new HttpError(400, error.message);
      throw error;
    }
  });

  app.get("/api/projects/native-picker", async () => nativePickerStatus());

  // Open the desktop folder dialog on the machine running this API.
  app.post("/api/projects/native-picker", async (request) => {
    try {
      return { path: await nativePickDirectory((request.query as Query).start ?? null) };
    } catch (error) {
      if (error instanceof NativePickerError) throw new HttpError(503, error.message);
      if (error instanceof ProjectDirError) throw new HttpError(400, error.message);
      if ((error as Error)?.name === "TimeoutError") throw new HttpError(408, "The folder dialog timed out");
      throw error;
    }
  });

}
