export type HeaderMap = Record<string, string>;

export interface JsonEdit {
  path: string;
  value: string;
}

export interface NetworkConditions {
  offline: boolean;
  latencyMs: number;
  downloadKbps: number;
  uploadKbps: number;
  failureRate: number;
}

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
  requestHeaders?: HeaderMap;
  responseHeaders?: HeaderMap;
  requestJsonEdits?: JsonEdit[];
  responseJsonEdits?: JsonEdit[];
  breakOnRequest?: boolean;
  breakOnResponse?: boolean;
  folder?: string;
  profiles?: string[];
}

export interface Settings {
  enabled: boolean;
  rules: Rule[];
  interceptionMode?: 'page' | 'full';
  tabModes?: Record<string, 'page' | 'full'>;
  activeProfiles?: string[];
  networkConditions?: NetworkConditions;
  trafficLimit?: number;
  trafficFilter?: string;
  preserveTraffic?: boolean;
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
  matchedRuleNames?: string[];
  error?: string;
}

export type PageConfigMessage = { source: 'network-modifier-extension'; type: 'config'; settings: Settings };
export type PageTrafficMessage = { source: 'network-modifier-page'; type: 'traffic'; record: TrafficRecord };

export const DEFAULT_NETWORK_CONDITIONS: NetworkConditions = {
  offline: false,
  latencyMs: 0,
  downloadKbps: 0,
  uploadKbps: 0,
  failureRate: 0
};

export const DEFAULT_SETTINGS: Settings = {
  enabled: true,
  rules: [],
  interceptionMode: 'page',
  tabModes: {},
  activeProfiles: ['All'],
  networkConditions: DEFAULT_NETWORK_CONDITIONS,
  trafficLimit: 1000,
  trafficFilter: '',
  preserveTraffic: true
};

export function modeForTab(settings: Settings, tabId: number): 'page' | 'full' {
  return settings.tabModes?.[String(tabId)] || settings.interceptionMode || 'page';
}
