import type { ReplyMarkup, TelegramMessage, TelegramUpdate } from "./types.js";

interface TelegramEnvelope<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

export class TelegramApiError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "TelegramApiError";
  }
}

export class TelegramApi {
  private readonly baseUrl: string;

  public constructor(
    token: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.baseUrl = `https://api.telegram.org/bot${token}`;
  }

  public async getUpdates(
    offset: number | undefined,
    signal: AbortSignal,
  ): Promise<TelegramUpdate[]> {
    return this.call<TelegramUpdate[]>(
      "getUpdates",
      {
        timeout: 50,
        allowed_updates: ["message", "callback_query"],
        ...(offset === undefined ? {} : { offset }),
      },
      signal,
    );
  }

  public async sendMessage(
    chatId: string,
    text: string,
    replyMarkup?: ReplyMarkup,
  ): Promise<TelegramMessage> {
    return this.call<TelegramMessage>("sendMessage", {
      chat_id: chatId,
      text,
      disable_web_page_preview: true,
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }

  public async setMyCommands(
    commands: ReadonlyArray<{ command: string; description: string }>,
  ): Promise<boolean> {
    return this.call<boolean>("setMyCommands", { commands });
  }

  public async answerCallbackQuery(
    callbackQueryId: string,
    text?: string,
    showAlert = false,
  ): Promise<boolean> {
    return this.call<boolean>("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
      show_alert: showAlert,
    });
  }

  private async call<T>(
    method: string,
    body: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    let response: Response;
    try {
      response = await this.fetchFn(`${this.baseUrl}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      throw new TelegramApiError(
        error instanceof Error && error.name === "AbortError"
          ? "Telegram request was stopped"
          : "Telegram network request failed",
        "TELEGRAM_NETWORK_ERROR",
      );
    }
    const payload = (await response
      .json()
      .catch(() => ({}))) as TelegramEnvelope<T>;
    if (!response.ok || !payload.ok || payload.result === undefined) {
      throw new TelegramApiError(
        payload.description || `Telegram API returned HTTP ${response.status}`,
        payload.error_code
          ? `TELEGRAM_${payload.error_code}`
          : "TELEGRAM_API_ERROR",
      );
    }
    return payload.result;
  }
}
