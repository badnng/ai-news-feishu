import {
  WorkflowEntrypoint,
  WorkflowStep,
} from "cloudflare:workers";

import type {
  WorkflowEvent,
} from "cloudflare:workers";

/**
 * ============================================================
 * Cloudflare Environment
 * ============================================================
 */

interface Env {
  // OpenAI / OpenAI-compatible Responses API
  LLM_BASE_URL: string;
  LLM_API_KEY: string;
  LLM_MODEL: string;

  // Optional
  LLM_RESPONSES_PATH?: string;
  REASONING_EFFORT?: string;
  LLM_BACKGROUND_MODE?: string;
  SEARCH_CONTEXT_SIZE?: string;

  // Research settings
  SEARCH_LOOKBACK_HOURS?: string;
  MAX_NEWS_COUNT?: string;
  MAX_RESEARCH_SECONDS?: string;
  POLL_INTERVAL_SECONDS?: string;
  REPORT_LANGUAGE?: string;

  // Feishu
  FEISHU_WEBHOOK_URL: string;

  // Protect /api/*
  API_AUTH_TOKEN: string;

  // Workflow binding
  AI_NEWS_WORKFLOW: Workflow<ResearchParams>;
}

/**
 * ============================================================
 * Types
 * ============================================================
 */

interface ResearchParams {
  query?: string;
  model?: string;
  reasoning_effort?: string;
  max_research_seconds?: number;
}

interface OpenAIResponse {
  id: string;
  status:
    | "queued"
    | "in_progress"
    | "completed"
    | "failed"
    | "cancelled"
    | "incomplete"
    | string;

  model?: string;

  output?: Array<any>;

  error?: {
    code?: string;
    message?: string;
  } | null;
}

interface Source {
  title: string;
  url: string;
}

interface ParsedReport {
  text: string;
  sources: Source[];
}

/**
 * ============================================================
 * Helpers
 * ============================================================
 */

function json(
  data: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-headers":
        "Content-Type, Authorization",
      "access-control-allow-methods":
        "GET, POST, OPTIONS",
    },
  });
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function normalizePath(path: string): string {
  if (!path.startsWith("/")) {
    return `/${path}`;
  }

  return path;
}

function responsesUrl(env: Env): string {
  const base = normalizeBaseUrl(env.LLM_BASE_URL);

  const path = normalizePath(
    env.LLM_RESPONSES_PATH || "/responses",
  );

  return `${base}${path}`;
}

function responseByIdUrl(
  env: Env,
  responseId: string,
): string {
  return `${responsesUrl(env)}/${encodeURIComponent(responseId)}`;
}

function parseBool(
  value: string | undefined,
  defaultValue: boolean,
): boolean {
  if (value === undefined) {
    return defaultValue;
  }

  return ["1", "true", "yes", "on"].includes(
    value.toLowerCase(),
  );
}

function parseNumber(
  value: string | undefined,
  defaultValue: number,
): number {
  if (!value) {
    return defaultValue;
  }

  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return defaultValue;
  }

  return parsed;
}

function clamp(
  value: number,
  min: number,
  max: number,
): number {
  return Math.max(min, Math.min(max, value));
}

function validateEnv(env: Env): void {
  const missing: string[] = [];

  if (!env.LLM_BASE_URL) {
    missing.push("LLM_BASE_URL");
  }

  if (!env.LLM_API_KEY) {
    missing.push("LLM_API_KEY");
  }

  if (!env.LLM_MODEL) {
    missing.push("LLM_MODEL");
  }

  if (!env.FEISHU_WEBHOOK_URL) {
    missing.push("FEISHU_WEBHOOK_URL");
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing environment variables: ${missing.join(", ")}`,
    );
  }
}

function isAuthorized(
  request: Request,
  env: Env,
): boolean {
  if (!env.API_AUTH_TOKEN) {
    return false;
  }

  const authorization =
    request.headers.get("Authorization");

  return authorization ===
    `Bearer ${env.API_AUTH_TOKEN}`;
}

/**
 * ============================================================
 * Research Prompt
 * ============================================================
 */

function buildResearchPrompt(
  env: Env,
  customQuery?: string,
): string {
  const lookback = clamp(
    parseNumber(
      env.SEARCH_LOOKBACK_HOURS,
      24,
    ),
    1,
    24 * 30,
  );

  const maxNews = clamp(
    parseNumber(
      env.MAX_NEWS_COUNT,
      8,
    ),
    1,
    20,
  );

  const language =
    env.REPORT_LANGUAGE || "zh-CN";

  const topic =
    customQuery?.trim() ||
    "搜索人工智能、AI模型、LLM、AI Agent、AI公司和重要AI产品的最新新闻";

  return `
你是一名专业的 AI 新闻研究员。

当前任务：

${topic}

你必须使用网络搜索工具进行实时搜索。

搜索要求：

1. 主要搜索最近 ${lookback} 小时内发生的 AI 新闻。
2. 最多选择 ${maxNews} 条真正重要的新闻。
3. 优先来源：
   - 公司官方博客
   - 官方公告
   - 官方文档
   - 官方 GitHub
   - 学术论文
   - Reuters
   - Bloomberg
   - Financial Times
   - The Verge
   - TechCrunch
   - Wired
   - Ars Technica
   - 其他可信科技媒体

4. 同一个事件如果有多个媒体报道，只保留一条新闻。
5. 尽可能使用一手来源。
6. 不要编造新闻。
7. 不要编造来源。
8. 对重大新闻尽量交叉验证。
9. 必须保留引用来源。
10. 如果搜索不到可靠证据，就不要写入报告。

输出格式：

# AI 新闻速报

## 1. 新闻标题

**发生了什么：**
简要说明。

**为什么重要：**
解释这件事为什么值得关注。

**关键信息：**
- 信息1
- 信息2
- 信息3

然后继续下一条。

最后增加：

## 今日趋势

总结今天 AI 行业最值得关注的 2-4 个趋势。

输出语言：
${language}

不要在正文最后自己伪造 URL。
请依赖 Web Search 的真实 citation。
`.trim();
}

/**
 * ============================================================
 * OpenAI Responses API
 * ============================================================
 */

async function createAIResponse(
  env: Env,
  params: ResearchParams,
): Promise<OpenAIResponse> {
  const url = responsesUrl(env);

  const reasoningEffort =
    params.reasoning_effort ||
    env.REASONING_EFFORT ||
    "high";

  const background = parseBool(
    env.LLM_BACKGROUND_MODE,
    true,
  );

  const webSearchTool: Record<string, unknown> = {
    type: "web_search",
  };

  /**
   * Optional.
   * Some OpenAI-compatible services only support:
   *
   * { type: "web_search" }
   *
   * so this is only added when configured.
   */
  if (env.SEARCH_CONTEXT_SIZE) {
    webSearchTool.search_context_size =
      env.SEARCH_CONTEXT_SIZE;
  }

  const body = {
    model:
      params.model ||
      env.LLM_MODEL,

    background,

    reasoning: {
      effort: reasoningEffort,
    },

    tools: [
      webSearchTool,
    ],

    input: buildResearchPrompt(
      env,
      params.query,
    ),
  };

  console.log(
    "Creating Responses API request",
    {
      url,
      model: body.model,
      reasoning_effort: reasoningEffort,
      background,
    },
  );

  const response = await fetch(url, {
    method: "POST",

    headers: {
      "content-type": "application/json",

      authorization:
        `Bearer ${env.LLM_API_KEY}`,
    },

    body: JSON.stringify(body),
  });

  const responseText =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Responses API error ${response.status}: ${responseText}`,
    );
  }

  let data: OpenAIResponse;

  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(
      `LLM endpoint returned invalid JSON: ${responseText.slice(0, 1000)}`,
    );
  }

  if (!data.id) {
    throw new Error(
      `Responses API returned no response id: ${responseText.slice(0, 1000)}`,
    );
  }

  return data;
}

async function retrieveAIResponse(
  env: Env,
  responseId: string,
): Promise<OpenAIResponse> {
  const url =
    responseByIdUrl(
      env,
      responseId,
    );

  const response = await fetch(url, {
    method: "GET",

    headers: {
      "content-type": "application/json",

      authorization:
        `Bearer ${env.LLM_API_KEY}`,
    },
  });

  const responseText =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Responses retrieve error ${response.status}: ${responseText}`,
    );
  }

  try {
    return JSON.parse(responseText);
  } catch {
    throw new Error(
      `LLM endpoint returned invalid JSON while polling`,
    );
  }
}

/**
 * ============================================================
 * Parse Responses API output
 * ============================================================
 */

function parseResponseOutput(
  response: OpenAIResponse,
): ParsedReport {
  const textParts: string[] = [];

  const sourceMap =
    new Map<string, Source>();

  for (
    const item of response.output || []
  ) {
    if (
      item?.type !== "message" ||
      !Array.isArray(item.content)
    ) {
      continue;
    }

    for (
      const content of item.content
    ) {
      if (
        content?.type !== "output_text"
      ) {
        continue;
      }

      if (
        typeof content.text === "string"
      ) {
        textParts.push(content.text);
      }

      if (
        !Array.isArray(content.annotations)
      ) {
        continue;
      }

      for (
        const annotation
        of content.annotations
      ) {
        if (
          annotation?.type !== "url_citation"
        ) {
          continue;
        }

        const url =
          annotation.url;

        if (
          typeof url !== "string" ||
          !url.startsWith("http")
        ) {
          continue;
        }

        const title =
          typeof annotation.title === "string"
            ? annotation.title
            : "查看原文";

        sourceMap.set(url, {
          title,
          url,
        });
      }
    }
  }

  return {
    text:
      textParts.join("\n\n").trim(),

    sources:
      [...sourceMap.values()],
  };
}

/**
 * OpenAI Responses Web Search citations are returned through
 * output_text.annotations with type=url_citation.
 */

/**
 * ============================================================
 * Feishu helpers
 * ============================================================
 */

function escapeLarkText(
  value: string,
): string {
  return value
    .replace(/\r/g, "")
    .trim();
}

function truncate(
  value: string,
  maxLength: number,
): string {
  if (
    value.length <= maxLength
  ) {
    return value;
  }

  return `${value.slice(
    0,
    maxLength,
  )}\n\n……内容过长，已截断`;
}

function splitText(
  value: string,
  maxLength = 3500,
): string[] {
  const result: string[] = [];

  let remaining =
    value.trim();

  while (
    remaining.length > maxLength
  ) {
    let cut =
      remaining.lastIndexOf(
        "\n",
        maxLength,
      );

    if (
      cut < maxLength * 0.5
    ) {
      cut = maxLength;
    }

    result.push(
      remaining.slice(0, cut),
    );

    remaining =
      remaining.slice(cut).trim();
  }

  if (remaining) {
    result.push(remaining);
  }

  return result;
}

function buildSourcesMarkdown(
  sources: Source[],
): string {
  if (
    sources.length === 0
  ) {
    return "本次报告未获取到可展示的原文链接。";
  }

  return sources
    .slice(0, 15)
    .map(
      (source, index) => {
        const safeTitle =
          source.title
            .replace(/\[/g, "【")
            .replace(/\]/g, "】");

        return `${index + 1}. [查看原文｜${safeTitle}](${source.url})`;
      },
    )
    .join("\n");
}

function buildFeishuCard(
  report: ParsedReport,
  meta: {
    model: string;
    reasoning: string;
  },
): unknown {
  const text = truncate(
    escapeLarkText(report.text),
    12000,
  );

  const chunks =
    splitText(text);

  const elements: any[] =
    chunks.map((chunk) => ({
      tag: "div",

      text: {
        tag: "lark_md",
        content: chunk,
      },
    }));

  elements.push({
    tag: "hr",
  });

  elements.push({
    tag: "div",

    text: {
      tag: "lark_md",

      content:
        `**🔗 原文来源**\n\n${buildSourcesMarkdown(
          report.sources,
        )}`,
    },
  });

  elements.push({
    tag: "hr",
  });

  elements.push({
    tag: "div",

    fields: [
      {
        is_short: true,
        text: {
          tag: "lark_md",
          content:
            `**模型**\n${meta.model}`,
        },
      },

      {
        is_short: true,
        text: {
          tag: "lark_md",
          content:
            `**Reasoning**\n${meta.reasoning}`,
        },
      },

      {
        is_short: true,
        text: {
          tag: "lark_md",
          content:
            `**引用来源**\n${report.sources.length}`,
        },
      },

      {
        is_short: true,
        text: {
          tag: "lark_md",
          content:
            `**生成时间**\n${new Date().toISOString()}`,
        },
      },
    ],
  });

  return {
    msg_type: "interactive",

    card: {
      config: {
        wide_screen_mode: true,
      },

      header: {
        template: "blue",

        title: {
          tag: "plain_text",
          content:
            "🤖 AI 新闻情报速报",
        },
      },

      elements,
    },
  };
}

async function sendFeishu(
  webhookUrl: string,
  payload: unknown,
): Promise<void> {
  const response =
    await fetch(webhookUrl, {
      method: "POST",

      headers: {
        "content-type":
          "application/json",
      },

      body:
        JSON.stringify(payload),
    });

  const body =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Feishu webhook error ${response.status}: ${body}`,
    );
  }

  console.log(
    "Feishu message sent",
    body,
  );
}

/**
 * ============================================================
 * Workflow
 * ============================================================
 */

export class AINewsWorkflow extends WorkflowEntrypoint<
  Env,
  ResearchParams
> {
  async run(
    event: WorkflowEvent<ResearchParams>,
    step: WorkflowStep,
  ) {
    validateEnv(this.env);

    const params =
      event.payload || {};

    const reasoning =
      params.reasoning_effort ||
      this.env.REASONING_EFFORT ||
      "high";

    const model =
      params.model ||
      this.env.LLM_MODEL;

    /**
     * Maximum research runtime
     */
    const configuredMax =
      params.max_research_seconds ??
      parseNumber(
        this.env.MAX_RESEARCH_SECONDS,
        300,
      );

    const maxResearchSeconds =
      clamp(
        configuredMax,
        30,
        1800,
      );

    const pollIntervalSeconds =
      clamp(
        parseNumber(
          this.env.POLL_INTERVAL_SECONDS,
          5,
        ),
        2,
        30,
      );

    /**
     * --------------------------------------------------------
     * Step 1
     * Create Responses request
     * --------------------------------------------------------
     */

    const created =
      await step.do(
        "create-ai-research",

        {
          retries: {
            limit: 3,
            delay: "10 seconds",
            backoff: "exponential",
          },
        },

        async () => {
          return await createAIResponse(
            this.env,
            params,
          );
        },
      );

    let responseId =
      created.id;

    let status =
      created.status;

    /**
     * In case endpoint returned an already completed response
     */
    let finalResponse:
      | OpenAIResponse
      | undefined =
      status === "completed"
        ? created
        : undefined;

    /**
     * --------------------------------------------------------
     * Step 2
     * Poll background Response
     * --------------------------------------------------------
     */

    if (
      status === "queued" ||
      status === "in_progress"
    ) {
      const maxPolls =
        Math.ceil(
          maxResearchSeconds /
            pollIntervalSeconds,
        );

      for (
        let i = 0;
        i < maxPolls;
        i++
      ) {
        await step.sleep(
          `wait-${i}`,
          `${pollIntervalSeconds} seconds`,
        );

        const polled =
          await step.do(
            `poll-${i}`,

            {
              retries: {
                limit: 3,
                delay: "5 seconds",
                backoff: "exponential",
              },
            },

            async () => {
              return await retrieveAIResponse(
                this.env,
                responseId,
              );
            },
          );

        status =
          polled.status;

        console.log(
          "Responses status",
          responseId,
          status,
        );

        if (
          status === "completed"
        ) {
          finalResponse =
            polled;

          break;
        }

        if (
          status !== "queued" &&
          status !== "in_progress"
        ) {
          throw new Error(
            `AI response ended with status=${status}: ${
              polled.error?.message ||
              "unknown error"
            }`,
          );
        }
      }
    }

    /**
     * --------------------------------------------------------
     * Timeout
     * --------------------------------------------------------
     */

    if (!finalResponse) {
      throw new Error(
        `AI research did not complete within ${maxResearchSeconds} seconds`,
      );
    }

    /**
     * --------------------------------------------------------
     * Step 3
     * Parse final report + citations
     * --------------------------------------------------------
     */

    const report =
      await step.do(
        "parse-result",
        async () => {
          const parsed =
            parseResponseOutput(
              finalResponse!,
            );

          if (!parsed.text) {
            throw new Error(
              "Responses API completed but returned no output text",
            );
          }

          return parsed;
        },
      );

    /**
     * --------------------------------------------------------
     * Step 4
     * Build Feishu rich card
     * --------------------------------------------------------
     */

    const card =
      await step.do(
        "build-feishu-card",
        async () => {
          return buildFeishuCard(
            report,
            {
              model,
              reasoning,
            },
          );
        },
      );

    /**
     * --------------------------------------------------------
     * Step 5
     * Send Feishu
     * --------------------------------------------------------
     */

    await step.do(
      "send-feishu",

      {
        retries: {
          limit: 5,
          delay: "10 seconds",
          backoff: "exponential",
        },
      },

      async () => {
        await sendFeishu(
          this.env
            .FEISHU_WEBHOOK_URL,

          card,
        );

        return {
          ok: true,
        };
      },
    );

    return {
      ok: true,

      response_id:
        responseId,

      model,

      reasoning_effort:
        reasoning,

      sources:
        report.sources.length,
    };
  }
}

/**
 * ============================================================
 * HTTP Worker
 * ============================================================
 */

export default {
  async fetch(
    request: Request,
    env: Env,
  ): Promise<Response> {
    const url =
      new URL(request.url);

    /**
     * CORS
     */
    if (
      request.method === "OPTIONS"
    ) {
      return new Response(null, {
        status: 204,

        headers: {
          "access-control-allow-origin":
            "*",

          "access-control-allow-headers":
            "Content-Type, Authorization",

          "access-control-allow-methods":
            "GET, POST, OPTIONS",
        },
      });
    }

    /**
     * --------------------------------------------------------
     * GET /
     * --------------------------------------------------------
     */

    if (
      request.method === "GET" &&
      url.pathname === "/"
    ) {
      return json({
        name:
          "AI News Feishu",

        status:
          "running",

        endpoints: {
          health:
            "GET /health",

          run:
            "POST /api/run",

          status:
            "GET /api/status/:id",
        },
      });
    }

    /**
     * --------------------------------------------------------
     * GET /health
     * --------------------------------------------------------
     */

    if (
      request.method === "GET" &&
      url.pathname === "/health"
    ) {
      return json({
        ok: true,
        service:
          "ai-news-feishu",
      });
    }

    /**
     * Everything below requires authentication
     */

    if (
      !isAuthorized(
        request,
        env,
      )
    ) {
      return json(
        {
          ok: false,
          error:
            "Unauthorized",
        },
        401,
      );
    }

    /**
     * --------------------------------------------------------
     * POST /api/run
     * --------------------------------------------------------
     */

    if (
      request.method === "POST" &&
      url.pathname === "/api/run"
    ) {
      try {
        validateEnv(env);

        let body:
          ResearchParams = {};

        try {
          body =
            await request.json<ResearchParams>();
        } catch {
          body = {};
        }

        /**
         * Validate override
         */
        if (
          body.max_research_seconds !==
            undefined &&
          (
            !Number.isFinite(
              body.max_research_seconds,
            ) ||
            body.max_research_seconds <
              30
          )
        ) {
          return json(
            {
              ok: false,

              error:
                "max_research_seconds must be >= 30",
            },
            400,
          );
        }

        const instance =
          await env
            .AI_NEWS_WORKFLOW
            .create({
              params: body,
            });

        return json({
          ok: true,

          workflow_id:
            instance.id,

          status:
            "queued",
        });
      } catch (error) {
        console.error(error);

        return json(
          {
            ok: false,

            error:
              error instanceof Error
                ? error.message
                : String(error),
          },
          500,
        );
      }
    }

    /**
     * --------------------------------------------------------
     * GET /api/status/:id
     * --------------------------------------------------------
     */

    if (
      request.method === "GET" &&
      url.pathname.startsWith(
        "/api/status/",
      )
    ) {
      try {
        const id =
          url.pathname
            .replace(
              "/api/status/",
              "",
            )
            .trim();

        if (!id) {
          return json(
            {
              ok: false,
              error:
                "Missing workflow id",
            },
            400,
          );
        }

        const instance =
          await env
            .AI_NEWS_WORKFLOW
            .get(id);

        const status =
          await instance.status();

        return json({
          ok: true,
          workflow_id: id,
          workflow:
            status,
        });
      } catch (error) {
        return json(
          {
            ok: false,

            error:
              error instanceof Error
                ? error.message
                : String(error),
          },
          500,
        );
      }
    }

    return json(
      {
        ok: false,
        error: "Not Found",
      },
      404,
    );
  },
} satisfies ExportedHandler<Env>;