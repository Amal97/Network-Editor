export type HeaderMap = Record<string, string>;

export interface Rule {
  id: string;
  name: string;
  enabled: boolean;
  urlPattern: string;
  method: string;
  delayMs: number;
  requestBody: string;
  responseBody: string;
  responseStatus: number;
  error: boolean;
}

export interface Settings {
  enabled: boolean;
  rules: Rule[];
}

export interface TrafficRecord {
  id: string;
  tabId?: number;
  frameUrl: string;
  transport: 'fetch' | 'xhr';
  method: string;
  url: string;
  startedAt: number;
  duration: number;
  status: number;
  originalStatus?: number;
  requestHeaders: HeaderMap;
  requestBody: string;
  responseHeaders: HeaderMap;
  responseBody: string;
  ruleIds: string[];
  error?: string;
}

export type PageConfigMessage = { source: 'network-modifier-extension'; type: 'config'; settings: Settings };
export type PageTrafficMessage = { source: 'network-modifier-page'; type: 'traffic'; record: TrafficRecord };

export const DEFAULT_SETTINGS: Settings = { enabled: true, rules: [] };
