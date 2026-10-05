const RENDER_API_BASE = "https://api.render.com/v1";

const GITHUB_REPO =
  "https://github.com/DoanGiaHuyVu/nene-build";

export type RenderDeployStatus =
  | "created"
  | "queued"
  | "build_in_progress"
  | "update_in_progress"
  | "live"
  | "build_failed"
  | "update_failed"
  | "canceled"
  | string;

export interface RenderServiceResult {
  serviceId: string;
  deployId: string;
  name: string;
  url: string;
  dashboardUrl: string;
}

export interface RenderDeployResult {
  id: string;
  status: RenderDeployStatus;
  createdAt?: string;
  updatedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  commit?: { id: string };
}

function getRenderConfig() {
  const apiKey = process.env.RENDER_API_KEY;
  const ownerId = process.env.RENDER_OWNER_ID;
  const region = process.env.RENDER_REGION ?? "oregon";

  if (!apiKey) {
    throw new RenderApiError(400, "RENDER_API_KEY is not configured");
  }

  if (!ownerId) {
    throw new RenderApiError(400, "RENDER_OWNER_ID is not configured");
  }

  return {
    apiKey,
    ownerId,
    region,
  };
}

async function renderRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const { apiKey } = getRenderConfig();

  const response = await fetch(
    `${RENDER_API_BASE}${path}`,
    {
      ...init,
      signal: AbortSignal.timeout(20_000),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
        ...(init.body
          ? { "Content-Type": "application/json" }
          : {}),
        ...init.headers,
      },
    },
  );

  const text = await response.text();

  let body: unknown = null;

  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (!response.ok) {
    throw new RenderApiError(response.status, `Render API returned HTTP ${response.status}`);
  }

  return body as T;
}

interface CreateRenderResponse {
  deployId: string;
  service: {
    id: string;
    name: string;
    dashboardUrl: string;
    serviceDetails: {
      url: string;
    };
  };
}

export async function createRenderService(
  taskId: string,
  branch: string,
  rootDir = "app",
): Promise<RenderServiceResult> {
  const { ownerId, region } = getRenderConfig();

  const shortId = taskId.slice(0, 8);

  const payload = {
    type: "web_service",
    name: `nene-${shortId}`,
    ownerId,
    repo: GITHUB_REPO,
    branch,
    rootDir,
    autoDeployTrigger: "off",
    serviceDetails: {
      runtime: "docker",
      plan: "free",
      region,
      envSpecificDetails: {
        dockerContext: ".",
        dockerfilePath: "./Dockerfile",
      },
    },
  };

  const result =
    await renderRequest<CreateRenderResponse>(
      "/services",
      {
        method: "POST",
        body: JSON.stringify(payload),
      },
    );

  return {
    serviceId: result.service.id,
    deployId: result.deployId,
    name: result.service.name,
    url: result.service.serviceDetails.url,
    dashboardUrl: result.service.dashboardUrl,
  };
}

export async function getRenderDeploy(
  serviceId: string,
  deployId: string,
): Promise<RenderDeployResult> {
  return renderRequest<RenderDeployResult>(
    `/services/${encodeURIComponent(
      serviceId,
    )}/deploys/${encodeURIComponent(
      deployId,
    )}`,
  );
}

export async function triggerRenderDeploy(
  serviceId: string,
  commitId: string
): Promise<RenderDeployResult> {
  return renderRequest<RenderDeployResult>(
    `/services/${encodeURIComponent(
      serviceId
    )}/deploys`,
    {
      method: "POST",
      body: JSON.stringify({
        commitId,
        clearCache:
          "do_not_clear",
      }),
    }
  );
}

export class RenderApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

interface RenderService {
  id: string;
  name: string;
  branch: string;
  repo?: string;
  dashboardUrl: string;
  serviceDetails: { url?: string };
}

export async function getRenderService(serviceId: string) {
  const service = await renderRequest<RenderService>(`/services/${encodeURIComponent(serviceId)}`);
  return { serviceId: service.id, url: service.serviceDetails.url, dashboardUrl: service.dashboardUrl };
}

// Reconcile a response lost during creation before considering any new POST.
export async function findRenderService(projectId: string, branch: string) {
  const { ownerId } = getRenderConfig();
  const query = new URLSearchParams({ name: `nene-${projectId.slice(0, 8)}`, ownerId, limit: "100" });
  const result = await renderRequest<Array<{ service: RenderService; cursor: string }>>(`/services?${query}`);
  const matches = result.filter(({ service }) => service.branch === branch && service.repo?.replace(/\.git$/, "") === GITHUB_REPO);
  if (matches.length > 1) throw new Error("Multiple Render services match this project; manual reconciliation required");
  const service = matches[0]?.service;
  return service ? { serviceId: service.id, url: service.serviceDetails.url, dashboardUrl: service.dashboardUrl } : undefined;
}

export async function findRenderDeploy(serviceId: string, commit: string, requestedAt: string) {
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ createdAfter: new Date(Date.parse(requestedAt) - 5000).toISOString(), limit: "100" });
    if (cursor) query.set("cursor", cursor);
    const page = await renderRequest<Array<{ deploy: RenderDeployResult; cursor: string }>>(`/services/${encodeURIComponent(serviceId)}/deploys?${query}`);
    const matching = page.find(({ deploy }) => deploy.commit?.id === commit);
    if (matching) return matching.deploy;
    cursor = page.length === 100 ? page[page.length - 1].cursor : undefined;
  } while (cursor);
  return undefined;
}
