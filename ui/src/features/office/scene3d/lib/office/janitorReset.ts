export type SessionEpochSnapshot = Record<string, number>;

export type OfficeCleaningCue = {
  id: string;
  agentId: string;
  agentName: string;
  ts: number;
};
