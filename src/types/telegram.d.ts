// Telegram WebApp types
// https://core.telegram.org/bots/webapps

declare global {
  interface Window {
    Telegram?: {
      WebApp: TelegramWebApp;
    };
  }
}

export interface TelegramWebApp {
  initData: string;
  initDataUnsafe: {
    query_id?: string;
    user?: {
      id: number;
      first_name?: string;
      last_name?: string;
      username?: string;
      language_code?: string;
      is_premium?: boolean;
    };
    receiver?: any;
    chat?: any;
    start_param?: string;
    can_send_after?: number;
    auth_date: number;
    hash: string;
  };
  version: string;
  platform: string;
  colorScheme: 'light' | 'dark';
  themeParams: {
    bg_color?: string;
    text_color?: string;
    hint_color?: string;
    link_color?: string;
    button_color?: string;
    button_text_color?: string;
    secondary_bg_color?: string;
  };
  isExpanded: boolean;
  viewportHeight: number;
  viewportStableHeight: number;
  headerColor: string;
  backgroundColor: string;
  isClosingConfirmationEnabled: boolean;
  BackButton: TelegramBackButton;
  MainButton: TelegramMainButton;
  HapticFeedback: TelegramHapticFeedback;

  ready(): void;
  expand(): void;
  close(): void;
  enableClosingConfirmation(): void;
  disableClosingConfirmation(): void;
  showPopup(params: TelegramPopupParams, callback?: (id?: string) => void): void;
  showAlert(message: string, callback?: () => void): void;
  showConfirm(message: string, callback?: (confirmed: boolean) => void): void;
  showScanQrPopup(params: TelegramQrPopupParams, callback?: (text: string) => boolean | void): void;
  closeScanQrPopup(): void;
  readTextFromClipboard(callback?: (text: string) => void): void;
  ready(): void;
  sendData(data: string): void;
  switchInlineQuery(query: string, choose_chat_types?: string[]): void;
  openLink(url: string, options?: { try_instant_view?: boolean }): void;
  openTelegramLink(url: string): void;
  openInvoice(url: string, callback?: (status: string) => void): void;
  setHeaderColor(color: string): void;
  setBackgroundColor(color: string): void;
  enableVerticalSwipes(): void;
  disableVerticalSwipes(): void;
  onEvent(event: TelegramEventType, callback: (...args: any[]) => void): void;
  offEvent(event: TelegramEventType, callback: (...args: any[]) => void): void;
}

export type TelegramEventType =
  | 'themeChanged'
  | 'viewportChanged'
  | 'mainButtonClicked'
  | 'backButtonClicked'
  | 'settingsButtonClicked'
  | 'invoiceClosed'
  | 'popupClosed'
  | 'qrTextReceived';

export interface TelegramBackButton {
  isVisible: boolean;
  onClick(callback: () => void): void;
  offClick(callback: () => void): void;
  show(): void;
  hide(): void;
}

export interface TelegramMainButton {
  text: string;
  color: string;
  textColor: string;
  isVisible: boolean;
  isActive: boolean;
  isProgressVisible: boolean;
  setText(text: string): void;
  onClick(callback: () => void): void;
  offClick(callback: () => void): void;
  show(): void;
  hide(): void;
  enable(): void;
  disable(): void;
  showProgress(leaveActive?: boolean): void;
  hideProgress(): void;
}

export interface TelegramHapticFeedback {
  impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
  notificationOccurred(type: 'error' | 'success' | 'warning'): void;
  selectionChanged(): void;
}

export interface TelegramPopupParams {
  title?: string;
  message: string;
  buttons?: TelegramPopupButton[];
}

export interface TelegramPopupButton {
  id?: string;
  type?: 'default' | 'ok' | 'close' | 'cancel' | 'destructive';
  text?: string;
}

export interface TelegramQrPopupParams {
  text?: string;
}
