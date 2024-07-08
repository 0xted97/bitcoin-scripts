export interface UnbondingPayload {
    staker_signed_signature_hex: string;
    staking_tx_hash_hex: string;
    unbonding_tx_hash_hex: string;
    unbonding_tx_hex: string;
  }