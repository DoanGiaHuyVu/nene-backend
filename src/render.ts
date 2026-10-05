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
}

function getRenderConfig() {
  const apiKey = process.env.RENDER_API_KEY;
  const ownerId = process.env.RENDER_OWNER_ID;
  const region = process.env.RENDER_REGION ?? "oregon";

  if (!apiKey) {
    throw new Error("RENDER_API_KEY is not configured");
  }

  if (!ownerId) {
    throw new Error("RENDER_OWNER_ID is not configured");
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
    throw new Error(
      `Render API ${response.status}: ${
        typeof body === "string"
          ? body
          : JSON.stringify(body)
      }`,
    );
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
