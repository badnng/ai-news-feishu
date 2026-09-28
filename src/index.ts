import {
  WorkflowEntrypoint,
  WorkflowStep,
} from "cloudflare:workers";

import type {
  WorkflowEvent,
} from "cloudflare:workers";

/**
 * ============================================================
 * Environment
 * ============================================================
 */

interface Env {
  // LLM
  LLM_BASE_URL: string;
  LLM_API_KEY: string;
  LLM_MODEL: string;

  LLM_RESPONSES_PATH?: string;
  REASONING_EFFORT?: string;
  LLM_BACKGROUND_MODE?: string;
  SEARCH_CONTEXT_SIZE?: string;

  // Research
  SEARCH_LOOKBACK_HOURS?: string;
  MAX_NEWS_COUNT?: string;
  MAX_RESEARCH_SECONDS?: string;
  POLL_INTERVAL_SECONDS?: string;
  REPORT_LANGUAGE?: string;

  // Feishu
  FEISHU_WEBHOOK_URL: string;

  // API authentication
  API_AUTH_TOKEN?: string;

  // Browser /run authentication
  RUN_SECRET?: string;

  // true = /run can be opened without ?key=
  // false = require /run?key=xxxxx
  RUN_PUBLIC?: string;

  // Workflow
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

  output?: any[];

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
 * Basic helpers
 * ============================================================
 */

function json(
  data: unknown,
  status = 200,
): Response {
  return new Response(
    JSON.stringify(data, null, 2),
    {
      status,

      headers: {
        "content-type":
          "application/json; charset=utf-8",

        "access-control-allow-origin":
          "*",

        "access-control-allow-headers":
          "Content-Type, Authorization",

        "access-control-allow-methods":
          "GET, POST, OPTIONS",
      },
    },
  );
}

function escapeHtml(
  value: string,
): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function parseBool(
  value: string | undefined,
  fallback: boolean,
): boolean {
  if (value === undefined) {
    return fallback;
  }

  return [
    "1",
    "true",
    "yes",
    "on",
  ].includes(
    value.toLowerCase(),
  );
}

function parseNumber(
  value: string | undefined,
  fallback: number,
): number {
  if (!value) {
    return fallback;
  }

  const parsed =
    Number(value);

  if (
    !Number.isFinite(parsed)
  ) {
    return fallback;
  }

  return parsed;
}

function clamp(
  value: number,
  min: number,
  max: number,
): number {
  return Math.max(
    min,
    Math.min(
      max,
      value,
    ),
  );
}

/**
 * ============================================================
 * Environment validation
 * ============================================================
 */

function validateEnv(
  env: Env,
): void {
  const missing:
    string[] = [];

  if (!env.LLM_BASE_URL) {
    missing.push(
      "LLM_BASE_URL",
    );
  }

  if (!env.LLM_API_KEY) {
    missing.push(
      "LLM_API_KEY",
    );
  }

  if (!env.LLM_MODEL) {
    missing.push(
      "LLM_MODEL",
    );
  }

  if (!env.FEISHU_WEBHOOK_URL) {
    missing.push(
      "FEISHU_WEBHOOK_URL",
    );
  }

  if (
    missing.length > 0
  ) {
    throw new Error(
      `Missing environment variables: ${missing.join(", ")}`,
    );
  }
}

/**
 * ============================================================
 * API URL
 * ============================================================
 */

function normalizeBaseUrl(
  baseUrl: string,
): string {
  return baseUrl.replace(
    /\/+$/,
    "",
  );
}

function normalizePath(
  path: string,
): string {
  return path.startsWith("/")
    ? path
    : `/${path}`;
}

function responsesUrl(
  env: Env,
): string {
  const base =
    normalizeBaseUrl(
      env.LLM_BASE_URL,
    );

  const path =
    normalizePath(
      env.LLM_RESPONSES_PATH ||
        "/responses",
    );

  return `${base}${path}`;
}

function responseByIdUrl(
  env: Env,
  responseId: string,
): string {
  return `${
    responsesUrl(env)
  }/${encodeURIComponent(
    responseId,
  )}`;
}

/**
 * ============================================================
 * Authentication
 * ============================================================
 */

function isApiAuthorized(
  request: Request,
  env: Env,
): boolean {
  if (!env.API_AUTH_TOKEN) {
    return false;
  }

  const authorization =
    request.headers.get(
      "Authorization",
    );

  return (
    authorization ===
    `Bearer ${env.API_AUTH_TOKEN}`
  );
}

function isRunAuthorized(
  url: URL,
  env: Env,
): boolean {
  /**
   * RUN_PUBLIC=true
   *
   * allows:
   *
   * /run
   */

  if (
    parseBool(
      env.RUN_PUBLIC,
      false,
    )
  ) {
    return true;
  }

  /**
   * Otherwise:
   *
   * /run?key=xxxxx
   */

  if (!env.RUN_SECRET) {
    return false;
  }

  const key =
    url.searchParams.get(
      "key",
    );

  return (
    key === env.RUN_SECRET
  );
}

/**
 * ============================================================
 * Prompt
 * ============================================================
 */

function buildResearchPrompt(
  env: Env,
  customQuery?: string,
): string {
  const lookback =
    clamp(
      parseNumber(
        env.SEARCH_LOOKBACK_HOURS,
        24,
      ),
      1,
      720,
    );

  const maxNews =
    clamp(
      parseNumber(
        env.MAX_NEWS_COUNT,
        8,
      ),
      1,
      20,
    );

  const language =
    env.REPORT_LANGUAGE ||
    "zh-CN";

  const query =
    customQuery?.trim() ||
    `
搜索最近的重要人工智能相关新闻，包括：

- OpenAI
- Anthropic
- Google DeepMind
- Gemini
- Claude
- ChatGPT
- Meta AI
- Microsoft AI
- NVIDIA
- xAI
- AI Agent
- LLM
- 多模态模型
- AI 编程
- AI 基础设施
- AI 开源模型
`;

  return `
你是一名专业的 AI 科技新闻研究员。

你必须使用网络搜索能力获取最新的信息。

当前任务：

${query}

搜索时间范围：

主要关注最近 ${lookback} 小时内发生的新闻。

最多选择 ${maxNews} 条真正重要的新闻。

==============================

来源优先级：

1. 官方网站
2. 官方 Blog
3. 官方公告
4. 官方开发者文档
5. 官方 GitHub
6. 学术论文
7. Reuters
8. Bloomberg
9. Financial Times
10. The Verge
11. TechCrunch
12. Ars Technica
13. Wired
14. 其他可靠媒体

==============================

要求：

- 必须进行网络搜索
- 不要依赖过时知识
- 不要编造新闻
- 不要编造来源
- 不要重复报道同一个事件
- 尽量寻找一手来源
- 重大新闻尽量进行交叉验证
- 如果没有可靠证据，不要写
- 优先真正有行业影响的新闻
- 保留真实引用来源

==============================

输出格式：

# 🤖 AI 新闻速报

## 1. 新闻标题

**发生了什么**

使用 1-3 段解释新闻。

**为什么重要**

解释这件事情对 AI 行业、开发者、公司或用户意味着什么。

**关键信息**

- 信息 1
- 信息 2
- 信息 3

---

## 2. 新闻标题

继续相同格式。

==============================

最后增加：

# 📊 今日 AI 趋势

总结今天最值得关注的 2-4 个趋势。

例如：

- 模型能力趋势
- Agent 趋势
- AI 编程趋势
- 开源模型趋势
- AI 公司竞争趋势

==============================

输出语言：

${language}

重要：

不要在正文中自己虚构 URL。
真实来源由 Web Search citation 提供。
`.trim();
}

/**
 * ============================================================
 * Responses API
 * ============================================================
 */

async function createAIResponse(
  env: Env,
  params: ResearchParams,
  options?: {
    prompt?: string;
    useWebSearch?: boolean;
  },
): Promise<OpenAIResponse> {
  const url = responsesUrl(env);
  const reasoningEffort =
    params.reasoning_effort ||
    env.REASONING_EFFORT ||
    "medium";
  const background = parseBool(
    env.LLM_BACKGROUND_MODE,
    false,
  );

  const body: Record<string, unknown> = {
    model: params.model || env.LLM_MODEL,
    background,
    reasoning: {
      effort: reasoningEffort,
    },
    input:
      options?.prompt ||
      buildResearchPrompt(env, params.query),
  };

  if (options?.useWebSearch !== false) {
    const webSearchTool: Record<string, unknown> = {
      type: "web_search",
    };

    if (env.SEARCH_CONTEXT_SIZE) {
      webSearchTool.search_context_size =
        env.SEARCH_CONTEXT_SIZE;
    }

    body.tools = [webSearchTool];
  }

  console.log("Creating AI response:", {
    url,
    model: body.model,
    reasoning: reasoningEffort,
    background,
    web_search: options?.useWebSearch !== false,
  });

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      authorization: `Bearer ${env.LLM_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  const text = await response.text();

  if (!response.ok) {
    const ray = response.headers.get("cf-ray");
    const server = response.headers.get("server");
    const extra = [
      ray ? `cf-ray=${ray}` : "",
      server ? `server=${server}` : "",
    ].filter(Boolean).join(" ");

    throw new Error(
      `Responses API error ${response.status}${extra ? ` (${extra})` : ""}: ${text.slice(0, 2000)}`,
    );
  }

  let data: OpenAIResponse;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(
      `LLM endpoint returned invalid JSON: ${text.slice(0, 1000)}`,
    );
  }

  if (!data.id) {
    throw new Error(
      `Responses API returned no response id: ${text.slice(0, 1000)}`,
    );
  }

  return data;
}

async function retrieveAIResponse(
  env: Env,
  responseId: string,
): Promise<OpenAIResponse> {
  const response =
    await fetch(
      responseByIdUrl(
        env,
        responseId,
      ),
      {
        method: "GET",

        headers: {
          authorization:
            `Bearer ${env.LLM_API_KEY}`,

          "content-type":
            "application/json",
        },
      },
    );

  const text =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Responses retrieve error ${response.status}: ${text}`,
    );
  }

  try {
    return JSON.parse(
      text,
    );
  } catch {
    throw new Error(
      "Invalid JSON while retrieving response",
    );
  }
}

/**
 * ============================================================
 * Parse AI response
 * ============================================================
 */

function parseResponseOutput(
  response: OpenAIResponse,
): ParsedReport {
  const textParts:
    string[] = [];

  const sourceMap =
    new Map<
      string,
      Source
    >();

  for (
    const item of
    response.output || []
  ) {
    if (
      item?.type === "web_search_call" &&
      Array.isArray(item?.action?.sources)
    ) {
      for (const source of item.action.sources) {
        const sourceUrl = source?.url;
        if (
          typeof sourceUrl !== "string" ||
          !sourceUrl.startsWith("http")
        ) {
          continue;
        }

        const title =
          typeof source?.title === "string"
            ? source.title
            : "查看原文";

        sourceMap.set(sourceUrl, {
          title,
          url: sourceUrl,
        });
      }
    }

    if (
      item?.type !== "message"
    ) {
      continue;
    }

    if (
      !Array.isArray(
        item.content,
      )
    ) {
      continue;
    }

    for (
      const content
      of item.content
    ) {
      if (
        content?.type !==
        "output_text"
      ) {
        continue;
      }

      if (
        typeof content.text ===
        "string"
      ) {
        textParts.push(
          content.text,
        );
      }

      if (
        !Array.isArray(
          content.annotations,
        )
      ) {
        continue;
      }

      for (
        const annotation
        of content.annotations
      ) {
        if (
          annotation?.type !==
          "url_citation"
        ) {
          continue;
        }

        const sourceUrl =
          annotation.url;

        if (
          typeof sourceUrl !==
            "string" ||
          !sourceUrl.startsWith(
            "http",
          )
        ) {
          continue;
        }

        const title =
          typeof annotation.title ===
          "string"
            ? annotation.title
            : "查看原文";

        sourceMap.set(
          sourceUrl,
          {
            title,
            url: sourceUrl,
          },
        );
      }
    }
  }

  return {
    text:
      textParts
        .join("\n\n")
        .trim(),

    sources:
      [
        ...sourceMap.values(),
      ],
  };
}

/**
 * ============================================================
 * Feishu
 * ============================================================
 */

function truncate(
  value: string,
  maxLength: number,
): string {
  if (
    value.length <= maxLength
  ) {
    return value;
  }

  return (
    value.slice(
      0,
      maxLength,
    ) +
    "\n\n……内容过长，已截断"
  );
}

function splitText(
  value: string,
  maxLength = 3500,
): string[] {
  const result:
    string[] = [];

  let remaining =
    value.trim();

  while (
    remaining.length >
    maxLength
  ) {
    let cut =
      remaining.lastIndexOf(
        "\n",
        maxLength,
      );

    if (
      cut <
      maxLength * 0.5
    ) {
      cut =
        maxLength;
    }

    result.push(
      remaining.slice(
        0,
        cut,
      ),
    );

    remaining =
      remaining
        .slice(cut)
        .trim();
  }

  if (remaining) {
    result.push(
      remaining,
    );
  }

  return result;
}

function buildSourcesMarkdown(
  sources: Source[],
): string {
  if (
    sources.length === 0
  ) {
    return (
      "没有获取到可展示的原文链接。"
    );
  }

  return sources
    .slice(
      0,
      20,
    )
    .map(
      (
        source,
        index,
      ) => {
        const title =
          source.title
            .replace(
              /\[/g,
              "【",
            )
            .replace(
              /\]/g,
              "】",
            );

        return (
          `${index + 1}. ` +
          `[查看原文｜${title}](${source.url})`
        );
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
  const reportText =
    truncate(
      report.text,
      12000,
    );

  const chunks =
    splitText(
      reportText,
    );

  const elements:
    any[] = [];

  for (
    const chunk of chunks
  ) {
    elements.push({
      tag: "div",

      text: {
        tag: "lark_md",
        content: chunk,
      },
    });
  }

  elements.push({
    tag: "hr",
  });

  elements.push({
    tag: "div",

    text: {
      tag: "lark_md",

      content:
        `**🔗 查看原文**\n\n${buildSourcesMarkdown(
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
            `**🤖 模型**\n${meta.model}`,
        },
      },

      {
        is_short: true,

        text: {
          tag: "lark_md",

          content:
            `**🧠 思考强度**\n${meta.reasoning}`,
        },
      },

      {
        is_short: true,

        text: {
          tag: "lark_md",

          content:
            `**🔗 来源数量**\n${report.sources.length}`,
        },
      },

      {
        is_short: true,

        text: {
          tag: "lark_md",

          content:
            `**⏰ 生成时间**\n${new Date().toISOString()}`,
        },
      },
    ],
  });

  return {
    msg_type:
      "interactive",

    card: {
      config: {
        wide_screen_mode:
          true,
      },

      header: {
        template:
          "blue",

        title: {
          tag:
            "plain_text",

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
    await fetch(
      webhookUrl,
      {
        method:
          "POST",

        headers: {
          "content-type":
            "application/json",
        },

        body:
          JSON.stringify(
            payload,
          ),
      },
    );

  const text =
    await response.text();

  if (!response.ok) {
    throw new Error(
      `Feishu webhook error ${response.status}: ${text}`,
    );
  }

  console.log(
    "Feishu sent:",
    text,
  );
}

const DEFAULT_RESEARCH_SHARDS = [
  {
    id: "frontier-models",
    title: "国际前沿模型",
    focus: "OpenAI、ChatGPT、Anthropic、Claude、Google DeepMind、Gemini、xAI、Grok，以及重要的新模型、API 和产品发布",
  },
  {
    id: "china-models",
    title: "中国模型与产品",
    focus: "DeepSeek、智谱 GLM、Xiaomi MiMo、字节跳动 Doubao/Seedance，以及重要的中国 AI 模型、Agent、开源项目和产品发布",
  },
  {
    id: "agents-infra",
    title: "Agent、编程与基础设施",
    focus: "AI Agent、AI 编程、代码模型、NVIDIA、推理/训练基础设施、开源模型、多模态模型和开发者工具",
  },
  {
    id: "tibo-x",
    title: "Tibo / X 动态",
    focus: "重点检查 https://x.com/thsottiaux 最近的公开帖子、相关讨论和上下文。只基于可验证公开内容判断是否出现所谓 reset 的迹象；证据不足时明确写证据不足，不要猜测",
  },
] as const;

function buildShardPrompt(
  env: Env,
  title: string,
  focus: string,
  customQuery?: string,
): string {
  const lookback = clamp(
    parseNumber(env.SEARCH_LOOKBACK_HOURS, 24),
    1,
    720,
  );
  const language = env.REPORT_LANGUAGE || "zh-CN";

  return [
    "你是一名 AI 新闻研究员。请使用 web_search，只完成一个窄范围搜索任务。",
    "",
    `分组：${title}`,
    `重点：${focus}`,
    customQuery ? `用户额外要求：${customQuery}` : "",
    `时间范围：优先最近 ${lookback} 小时。`,
    "最多保留 3 个真正重要、互不重复的事件。",
    "",
    "要求：",
    "- 必须使用 web_search。",
    "- 优先官方公告、官方博客、官方文档、论文和可靠媒体。",
    "- 同一事件不要重复。",
    "- 重要结论尽量交叉验证。",
    "- 不确定就明确说明，不要脑补。",
    "- 保留真实 citation。",
    "- 输出简洁，避免长篇背景介绍。",
    "",
    "每条事件格式：",
    "### 标题",
    "时间：尽量给出明确日期/时间",
    "发生了什么：2-4 句",
    "为什么重要：1-2 句",
    "证据/不确定性：必要时说明",
    "",
    `输出语言：${language}`,
  ].filter(Boolean).join("\n");
}

function buildSynthesisPrompt(
  env: Env,
  reports: Array<{ title: string; text: string }>,
  customQuery?: string,
): string {
  const maxNews = clamp(
    parseNumber(env.MAX_NEWS_COUNT, 8),
    1,
    20,
  );
  const language = env.REPORT_LANGUAGE || "zh-CN";
  const material = reports
    .map((report) => `## ${report.title}\n${report.text}`)
    .join("\n\n");

  return [
    "你是一名 AI 新闻编辑。下面是多个独立网络搜索步骤已经得到的材料。",
    "只能基于这些材料整理，不要添加材料中没有的事实，也不要假装再次联网。",
    customQuery ? `用户主题：${customQuery}` : "",
    `最多整理 ${maxNews} 条新闻。`,
    "",
    "规则：",
    "- 去重。同一事件来自多个分组时合并。",
    "- 优先影响范围大、信息新、来源可靠的事件。",
    "- 每条包含：标题、发生了什么、为什么重要。",
    "- 对 Tibo / reset 相关内容，只陈述材料支持的证据；证据不足就写“暂不足以判断”。",
    "- 不要输出 URL，原文链接会由程序单独附上。",
    "- 最后加“今日 AI 趋势”，总结 2-4 条趋势。",
    `- 输出语言：${language}`,
    "",
    "搜索材料：",
    material,
  ].filter(Boolean).join("\n");
}

async function runResponseStep(
  step: WorkflowStep,
  env: Env,
  params: ResearchParams,
  label: string,
  prompt: string,
  useWebSearch: boolean,
): Promise<OpenAIResponse> {
  const created = await step.do(
    `${label}-create`,
    {
      retries: {
        limit: 4,
        delay: "15 seconds",
        backoff: "exponential",
      },
    },
    async (ctx) => {
      console.log(`${label}: create attempt ${ctx.attempt}`);
      return await createAIResponse(env, params, {
        prompt,
        useWebSearch,
      });
    },
  );

  if (created.status === "completed") {
    return created;
  }

  if (
    created.status !== "queued" &&
    created.status !== "in_progress"
  ) {
    throw new Error(
      `${label}: response ended with status=${created.status}: ${created.error?.message || "unknown error"}`,
    );
  }

  const maxResearchSeconds = clamp(
    params.max_research_seconds ??
      parseNumber(env.MAX_RESEARCH_SECONDS, 300),
    30,
    1800,
  );
  const pollIntervalSeconds = clamp(
    parseNumber(env.POLL_INTERVAL_SECONDS, 5),
    2,
    30,
  );
  const maxPolls = Math.ceil(
    maxResearchSeconds / pollIntervalSeconds,
  );

  for (let i = 0; i < maxPolls; i++) {
    await step.sleep(
      `${label}-wait-${i}`,
      `${pollIntervalSeconds} seconds`,
    );

    const polled = await step.do(
      `${label}-poll-${i}`,
      {
        retries: {
          limit: 3,
          delay: "5 seconds",
          backoff: "exponential",
        },
      },
      async () =>
        await retrieveAIResponse(env, created.id),
    );

    if (polled.status === "completed") {
      return polled;
    }

    if (
      polled.status !== "queued" &&
      polled.status !== "in_progress"
    ) {
      throw new Error(
        `${label}: polling ended with status=${polled.status}: ${polled.error?.message || "unknown error"}`,
      );
    }
  }

  throw new Error(
    `${label}: did not complete within ${maxResearchSeconds} seconds`,
  );
}

function mergeSources(
  reports: ParsedReport[],
): Source[] {
  const map = new Map<string, Source>();

  for (const report of reports) {
    for (const source of report.sources) {
      if (!map.has(source.url)) {
        map.set(source.url, source);
      }
    }
  }

  return [...map.values()];
}

/**
 * ============================================================
 * Workflow
 * ============================================================
 */

export class AINewsWorkflow
  extends WorkflowEntrypoint<
    Env,
    ResearchParams
  > {
  async run(
    event: WorkflowEvent<ResearchParams>,
    step: WorkflowStep,
  ) {
    validateEnv(this.env);

    const params = event.payload || {};
    const model = params.model || this.env.LLM_MODEL;
    const reasoning =
      params.reasoning_effort ||
      this.env.REASONING_EFFORT ||
      "medium";
    const customQuery = params.query?.trim();

    const shards = customQuery
      ? [
          {
            id: "custom-primary",
            title: "自定义主题主搜索",
            focus: `围绕用户主题进行主搜索：${customQuery}`,
          },
          {
            id: "custom-verify",
            title: "自定义主题交叉验证",
            focus: `独立搜索并验证用户主题，优先寻找一手来源和不同来源的交叉证据：${customQuery}`,
          },
        ]
      : [...DEFAULT_RESEARCH_SHARDS];

    const successful: Array<{
      title: string;
      report: ParsedReport;
    }> = [];
    const failed: Array<{
      id: string;
      error: string;
    }> = [];

    for (const shard of shards) {
      try {
        const response = await runResponseStep(
          step,
          this.env,
          params,
          `search-${shard.id}`,
          buildShardPrompt(
            this.env,
            shard.title,
            shard.focus,
            customQuery,
          ),
          true,
        );

        const parsed = parseResponseOutput(response);

        if (!parsed.text) {
          throw new Error(
            `${shard.title}: completed but returned no output text`,
          );
        }

        successful.push({
          title: shard.title,
          report: parsed,
        });
      } catch (error) {
        const message =
          error instanceof Error
            ? error.message
            : String(error);
        console.error(`Shard failed: ${shard.id}`, message);
        failed.push({
          id: shard.id,
          error: message,
        });
      }
    }

    if (successful.length === 0) {
      throw new Error(
        `All research shards failed: ${failed.map((item) => `${item.id}: ${item.error}`).join(" | ")}`,
      );
    }

    let finalText = successful
      .map((item) =>
        `## ${item.title}\n\n${item.report.text}`,
      )
      .join("\n\n---\n\n");

    try {
      const synthesisResponse = await runResponseStep(
        step,
        this.env,
        params,
        "synthesize-report",
        buildSynthesisPrompt(
          this.env,
          successful.map((item) => ({
            title: item.title,
            text: item.report.text,
          })),
          customQuery,
        ),
        false,
      );

      const synthesis = parseResponseOutput(
        synthesisResponse,
      );

      if (synthesis.text) {
        finalText = synthesis.text;
      }
    } catch (error) {
      console.error(
        "Synthesis failed; using segmented results:",
        error instanceof Error
          ? error.message
          : String(error),
      );
    }

    const report: ParsedReport = {
      text: finalText,
      sources: mergeSources(
        successful.map((item) => item.report),
      ),
    };

    const card = await step.do(
      "build-feishu-card",
      async () =>
        buildFeishuCard(report, {
          model,
          reasoning,
        }),
    );

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
          this.env.FEISHU_WEBHOOK_URL,
          card,
        );
        return { ok: true };
      },
    );

    return {
      ok: true,
      model,
      reasoning_effort: reasoning,
      successful_shards: successful.length,
      total_shards: shards.length,
      failed_shards: failed,
      sources: report.sources.length,
    };
  }
}

/**
 * ============================================================
 * Worker
 * ============================================================
 */

export default {

  /**
   * ==========================================================
   * HTTP
   * ==========================================================
   */

  async fetch(
    request: Request,
    env: Env,
  ): Promise<Response> {
    const url =
      new URL(
        request.url,
      );

    /**
     * CORS
     */

    if (
      request.method ===
      "OPTIONS"
    ) {
      return new Response(
        null,
        {
          status: 204,

          headers: {
            "access-control-allow-origin":
              "*",

            "access-control-allow-headers":
              "Content-Type, Authorization",

            "access-control-allow-methods":
              "GET, POST, OPTIONS",
          },
        },
      );
    }

    /**
     * ========================================================
     * GET /
     * ========================================================
     */

    if (
      request.method ===
        "GET" &&
      url.pathname === "/"
    ) {
      return new Response(
        `<!DOCTYPE html>
<html lang="zh-CN">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
>

<title>AI News Feishu</title>

<style>

body {
  margin: 0;
  background: #f5f6f8;
  font-family:
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;
  color: #1f2329;
}

.container {
  max-width: 720px;
  margin: 70px auto;
  padding: 20px;
}

.card {
  background: white;
  border-radius: 18px;
  padding: 32px;
  box-shadow:
    0 10px 40px
    rgba(0,0,0,.08);
}

h1 {
  margin-top: 0;
}

.ok {
  color: #00a870;
}

code {
  background: #f2f3f5;
  padding: 4px 8px;
  border-radius: 6px;
}

p {
  line-height: 1.7;
}

</style>

</head>

<body>

<div class="container">

<div class="card">

<h1>🤖 AI News Feishu</h1>

<p class="ok">
● Worker 正常运行
</p>

<p>
自动定时任务：
Cloudflare Cron → Workflow → AI 搜索 → 飞书
</p>

<p>
手动启动：
</p>

<p>
<code>/run?key=你的RUN_SECRET</code>\n</p>\n\n<p>\n自定义主题：\n</p>\n\n<p>\n<code>/run?key=你的RUN_SECRET&amp;q=你的搜索主题</code>
</p>

<p>
如果设置：
</p>

<p>
<code>RUN_PUBLIC=true</code>
</p>

<p>
则可以直接访问：
</p>

<p>
<code>/run</code>
</p>

</div>

</div>

</body>

</html>`,
        {
          headers: {
            "content-type":
              "text/html; charset=utf-8",

            "cache-control":
              "no-store",
          },
        },
      );
    }

    /**
     * ========================================================
     * GET /health
     * ========================================================
     */

    if (
      request.method ===
        "GET" &&
      url.pathname ===
        "/health"
    ) {
      return json({
        ok: true,

        service:
          "ai-news-feishu",

        time:
          new Date()
            .toISOString(),
      });
    }

    /**
     * ========================================================
     * GET /run
     *
     * Browser manual trigger
     * ========================================================
     */

    if (
      request.method ===
        "GET" &&
      url.pathname ===
        "/run"
    ) {
      /**
       * Security
       */

      if (
        !isRunAuthorized(
          url,
          env,
        )
      ) {
        if (
          !parseBool(
            env.RUN_PUBLIC,
            false,
          ) &&
          !env.RUN_SECRET
        ) {
          return new Response(
            `
RUN_SECRET is not configured.

Go to:

Cloudflare
→ Workers & Pages
→ ai-news-feishu
→ Settings
→ Variables and Secrets

Add:

RUN_SECRET = your password

Then open:

/run?key=your password

Or set:

RUN_PUBLIC=true

to allow public /run access.
            `.trim(),
            {
              status: 503,

              headers: {
                "content-type":
                  "text/plain; charset=utf-8",
              },
            },
          );
        }

        return new Response(
          "Unauthorized",
          {
            status: 401,

            headers: {
              "content-type":
                "text/plain; charset=utf-8",
            },
          },
        );
      }

      try {
        validateEnv(
          env,
        );

        /**
         * Only create Workflow.
         *
         * Browser does NOT wait
         * for AI research.
         */

        const manualQuery =
          url.searchParams
            .get("q")
            ?.trim();

        const instance =
          await env
            .AI_NEWS_WORKFLOW
            .create({
              params: manualQuery
                ? { query: manualQuery }
                : {},
            });

        return new Response(
          `<!DOCTYPE html>

<html lang="zh-CN">

<head>

<meta charset="UTF-8">

<meta
  name="viewport"
  content="width=device-width, initial-scale=1.0"
>

<title>AI 新闻抓取已启动</title>

<style>

body {
  margin: 0;

  font-family:
    -apple-system,
    BlinkMacSystemFont,
    "Segoe UI",
    sans-serif;

  background:
    #f5f6f8;

  color:
    #1f2329;
}

.container {
  max-width:
    680px;

  margin:
    80px auto;

  padding:
    24px;
}

.card {
  background:
    white;

  border-radius:
    18px;

  padding:
    34px;

  box-shadow:
    0 10px 40px
    rgba(0,0,0,.08);
}

h1 {
  margin-top:
    0;

  font-size:
    28px;
}

.status {
  margin-top:
    22px;

  padding:
    18px;

  border-radius:
    12px;

  background:
    #eef6ff;

  color:
    #245bdb;

  font-weight:
    600;
}

.description {
  color:
    #646a73;

  line-height:
    1.8;

  margin-top:
    22px;
}

.workflow {
  margin-top:
    22px;

  background:
    #f5f6f8;

  padding:
    14px;

  border-radius:
    10px;

  word-break:
    break-all;

  font-family:
    monospace;
}

.success {
  color:
    #00a870;
}

</style>

</head>

<body>

<div class="container">

<div class="card">

<h1>
🤖 AI 新闻抓取任务已启动
</h1>

<div class="status">
🔎 正在后台搜索最新 AI 新闻……
</div>

<p class="description">

Cloudflare Workflow
已经成功创建。

<br><br>

现在可以直接关闭这个网页。

<br><br>

Workflow 会继续在 Cloudflare
后台运行，调用 AI 模型进行网络搜索、
分析和整理。

<br><br>

完成后会自动把 AI 新闻富文本卡片发送到飞书机器人。

</p>

<p class="success">
✓ 后台任务启动成功
</p>

<div class="workflow">

Workflow ID:

<br><br>

${escapeHtml(
  instance.id,
)}

</div>

</div>

</div>

</body>

</html>`,
          {
            status: 200,

            headers: {
              "content-type":
                "text/html; charset=utf-8",

              "cache-control":
                "no-store",
            },
          },
        );
      } catch (
        error
      ) {
        console.error(
          error,
        );

        const message =
          error instanceof
          Error
            ? error.message
            : String(
                error,
              );

        return new Response(
          `<!DOCTYPE html>

<html lang="zh-CN">

<head>

<meta charset="UTF-8">

<title>启动失败</title>

</head>

<body>

<h1>
❌ Workflow 启动失败
</h1>

<pre>${escapeHtml(
  message,
)}</pre>

</body>

</html>`,
          {
            status: 500,

            headers: {
              "content-type":
                "text/html; charset=utf-8",
            },
          },
        );
      }
    }

    /**
     * ========================================================
     * API authentication
     * ========================================================
     */

    if (
      !isApiAuthorized(
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
     * ========================================================
     * POST /api/run
     * ========================================================
     */

    if (
      request.method ===
        "POST" &&
      url.pathname ===
        "/api/run"
    ) {
      try {
        validateEnv(
          env,
        );

        let body:
          ResearchParams = {};

        try {
          body =
            await request
              .json<ResearchParams>();
        } catch {
          body = {};
        }

        const instance =
          await env
            .AI_NEWS_WORKFLOW
            .create({
              params:
                body,
            });

        return json({
          ok: true,

          workflow_id:
            instance.id,

          status:
            "queued",
        });
      } catch (
        error
      ) {
        console.error(
          error,
        );

        return json(
          {
            ok: false,

            error:
              error instanceof
              Error
                ? error.message
                : String(
                    error,
                  ),
          },
          500,
        );
      }
    }

    /**
     * ========================================================
     * GET /api/status/:id
     * ========================================================
     */

    if (
      request.method ===
        "GET" &&
      url.pathname
        .startsWith(
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
          await instance
            .status();

        return json({
          ok: true,

          workflow_id:
            id,

          workflow:
            status,
        });
      } catch (
        error
      ) {
        return json(
          {
            ok: false,

            error:
              error instanceof
              Error
                ? error.message
                : String(
                    error,
                  ),
          },
          500,
        );
      }
    }

    return json(
      {
        ok: false,
        error:
          "Not Found",
      },
      404,
    );
  },

  /**
   * ==========================================================
   * Cron
   *
   * Free Workers Cron Trigger
   * ==========================================================
   */

  async scheduled(
    controller:
      ScheduledController,

    env: Env,

    ctx:
      ExecutionContext,
  ): Promise<void> {
    console.log(
      "Cron triggered:",
      controller.cron,
    );

    /**
     * Cron itself does NOT
     * perform AI research.
     *
     * It only creates Workflow.
     */

    ctx.waitUntil(
      (
        async () => {
          try {
            validateEnv(
              env,
            );

            const instance =
              await env
                .AI_NEWS_WORKFLOW
                .create({
                  params: {},
                });

            console.log(
              "Scheduled Workflow created:",
              instance.id,
            );
          } catch (
            error
          ) {
            console.error(
              "Scheduled Workflow failed:",
              error,
            );

            throw error;
          }
        }
      )(),
    );
  },

} satisfies ExportedHandler<Env>;
