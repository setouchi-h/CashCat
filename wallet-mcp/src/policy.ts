import { PublicKey } from "@solana/web3.js";
import { config } from "./config.js";

export interface SwapPolicyInput {
  inputMint: string;
  outputMint: string;
  amountLamports: number;
  slippageBps: number;
}

export function isValidMint(value: string): boolean {
  if (!value || value.length < 32 || value.length > 44) return false;
  try {
    new PublicKey(value);
    return true;
  } catch {
    return false;
  }
}

export function validateSwapPolicy(input: SwapPolicyInput): string | null {
  if (config.policy.killSwitch) {
    return "Global kill switch is enabled";
  }
  if (!isValidMint(input.inputMint)) {
    return "inputMint is invalid";
  }
  if (!isValidMint(input.outputMint)) {
    return "outputMint is invalid";
  }
  if (input.inputMint === input.outputMint) {
    return "inputMint and outputMint must differ";
  }
  if (!Number.isInteger(input.amountLamports) || input.amountLamports <= 0) {
    return "amountLamports must be a positive integer";
  }
  if (input.amountLamports > config.policy.maxAmountLamports) {
    return `amountLamports exceeds maxAmountLamports (${config.policy.maxAmountLamports})`;
  }
  if (!Number.isInteger(input.slippageBps) || input.slippageBps <= 0) {
    return "slippageBps must be a positive integer";
  }
  if (input.slippageBps > config.policy.maxSlippageBps) {
    return `slippageBps exceeds maxSlippageBps (${config.policy.maxSlippageBps})`;
  }
  if (
    config.policy.allowedInputMints.length > 0 &&
    !config.policy.allowedInputMints.includes(input.inputMint)
  ) {
    return "inputMint not in allowedInputMints";
  }
  if (
    config.policy.allowedOutputMints.length > 0 &&
    !config.policy.allowedOutputMints.includes(input.outputMint)
  ) {
    return "outputMint not in allowedOutputMints";
  }

  return null;
}
