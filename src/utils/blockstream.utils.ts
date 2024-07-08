import { UTXO } from 'btc-staking-ts';
import { Fees } from '../configs';
import { getNetworkConfig } from './../configs/network.config';


const { mempoolApiUrl } = getNetworkConfig();

import axios, { AxiosResponse } from "axios";

const blockstream = new axios.Axios({
  baseURL: `${mempoolApiUrl}/api`
});

export async function getTransactionHex(txIdHex: string) {
  const response: AxiosResponse<string> = await blockstream.get(`/tx/${txIdHex}/hex`);
  return response.data;
}

export async function broadcast(txHex: string) {
  const response: AxiosResponse<string> = await blockstream.post('/tx', txHex);
  return response.data;
}

export async function getUTXOs(address: string): Promise<any[]> {
  const url = `${mempoolApiUrl}/api/address/${address}/utxo`;
  const response = await fetch(url);
  return response.json();
}

// Function to get the BTC balance
async function getBalance(address: string): Promise<number> {
  const utxos = await getUTXOs(address);
  return utxos.reduce((acc, utxo) => acc + utxo.value, 0) / 1e8; // convert satoshi to BTC
}

export async function getAddressBalance(address: string): Promise<number> {
  const response = await fetch(`${mempoolApiUrl}/api/address/${address}`);
  if (!response.ok) {
    const err = await response.text();
    throw new Error(err);
  } else {
    const addressInfo = await response.json();
    return (
      addressInfo.chain_stats.funded_txo_sum -
      addressInfo.chain_stats.spent_txo_sum
    );
  }
}

export async function validateAddress(address: string): Promise<{ isvalid: string, scriptPubKey: string }> {
  const response = await fetch(`${mempoolApiUrl}/api/v1/validate-address/${address}`);
  const addressInfo = await response.json();
  return addressInfo;
}

/**
 * Retrieve a set of UTXOs that are available to an address
 * and satisfy the `amount` requirement if provided. Otherwise, fetch all UTXOs.
 * The UTXOs are chosen based on descending amount order.
 * @param address - The Bitcoin address in string format.
 * @param amount - The amount we expect the resulting UTXOs to satisfy.
 * @returns A promise that resolves into a list of UTXOs.
 */
export async function getFundingUTXOs(
  address: string,
  amount?: number,
): Promise<UTXO[]> {
  // Get all UTXOs for the given address

  let utxos = await getUTXOs(address);

  // Remove unconfirmed UTXOs as they are not yet available for spending
  // and sort them in descending order according to their value.
  // We want them in descending order, as we prefer to find the least number
  // of inputs that will satisfy the `amount` requirement,
  // as less inputs lead to a smaller transaction and therefore smaller fees.
  const confirmedUTXOs = utxos
    .filter((utxo: any) => utxo.status.confirmed)
    .sort((a: any, b: any) => b.value - a.value);

  // If amount is provided, reduce the list of UTXOs into a list that
  // contains just enough UTXOs to satisfy the `amount` requirement.
  let sliced = confirmedUTXOs;
  if (amount) {
    var sum = 0;
    for (var i = 0; i < confirmedUTXOs.length; ++i) {
      sum += confirmedUTXOs[i].value;
      if (sum > amount) {
        break;
      }
    }
    if (sum < amount) {
      return [];
    }
    sliced = confirmedUTXOs.slice(0, i + 1);
  }

  const addressInfo = await validateAddress(address)
  const { isvalid, scriptPubKey } = addressInfo;
  if (!isvalid) {
    throw new Error("Invalid address");
  }

  // Iterate through the final list of UTXOs to construct the result list.
  // The result contains some extra information,
  return sliced.map((s: any) => {
    return {
      txid: s.txid,
      vout: s.vout,
      value: s.value,
      scriptPubKey: scriptPubKey,
    };
  });
}


export async function getNetworkFees(): Promise<Fees> {
  const response = await fetch(`${mempoolApiUrl}/api/v1/fees/recommended`);
  if (!response.ok) {
    const err = await response.text();
    throw new Error(err);
  } else {
    return await response.json();
  }
}

export async function getBlockHeight(): Promise<number> {
  const response = await fetch(`${mempoolApiUrl}/api/blocks/tip/height`);
  if (!response.ok) {
    const err = await response.text();
    throw new Error(err);
  } else {
    const blockInfo = await response.json();
    return blockInfo;
  }
}