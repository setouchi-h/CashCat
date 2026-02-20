export interface ExecutionIntent {
  type: "execution-intent";
  id: string;
  createdAt: string;
  expiresAt?: string;
  action: "buy" | "sell";
  inputMint: string;
  outputMint: string;
  amountLamports: number;
  slippageBps: number;
  metadata?: Record<string, unknown>;
}

export interface ExecutionResult {
  type: "execution-result";
  intentId: string;
  createdAt: string;
  status: "filled" | "failed" | "rejected" | "expired";
  txHash?: string;
  inputAmount: string;
  outputAmount: string;
  error?: string;
  reason?: string;
}

export interface ImprovementProposal {
  type: "improvement-proposal";
  id: string;
  createdAt: string;
  candidateId: string;
  metrics: {
    pnlDeltaPct: number;
    sharpeDelta: number;
    maxDrawdownDeltaPct: number;
    testPassRate: number;
  };
  artifacts?: {
    reportRef?: string;
    patchRef?: string;
  };
  notes?: string;
}

export interface ImprovementVerdict {
  type: "improvement-verdict";
  proposalId: string;
  candidateId: string;
  createdAt: string;
  decision: "accept" | "reject";
  reason: string;
  metrics: ImprovementProposal["metrics"];
  gate: {
    minPnlDeltaPct: number;
    minSharpeDelta: number;
    maxDrawdownDeltaPct: number;
    minTestPassRate: number;
  };
}

export interface RuntimeQueueItem<T> {
  payload: T;
  filePath: string;
}
