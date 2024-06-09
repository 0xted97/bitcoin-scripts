export type Fees = {
    // fee for inclusion in the next block
    fastestFee: number;
    // fee for inclusion in a block in 30 mins
    halfHourFee: number;
    // fee for inclusion in a block in 1 hour
    hourFee: number;
    // economy fee: inclusion not guaranteed
    economyFee: number;
    // minimum fee: the minimum fee of the network
    minimumFee: number;
};

export enum Network {
    MAINNET = "mainnet",
    TESTNET = "testnet",
    SIGNET = "signet",
}

export interface UTXO {
    // hash of transaction that holds the UTXO
    txid: string;
    // index of the output in the transaction
    vout: number;
    // amount of satoshis the UTXO holds
    value: number;
    // the script that the UTXO contains
    scriptPubKey: string;
  }
  