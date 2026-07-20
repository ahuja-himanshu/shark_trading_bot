export interface TelegramUser {
  id: number;
  is_bot: boolean;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  text?: string;
  forward_date?: number;
  forward_origin?: unknown;
  reply_to_message?: TelegramMessage;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface InlineButton {
  text: string;
  callback_data: string;
}

export interface ReplyMarkup {
  inline_keyboard?: InlineButton[][];
  force_reply?: boolean;
  selective?: boolean;
  input_field_placeholder?: string;
}
