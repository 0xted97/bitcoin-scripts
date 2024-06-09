import { Signer, networks, Psbt } from 'bitcoinjs-lib';
import { getNetworkConfig } from './configs/network.config';
import { Fees, initWallet } from './configs';
// Helper function to fetch UTXOs from a blockchain explorer
const { mempoolApiUrl } = getNetworkConfig();
async function getUTXOs(address: string): Promise<any[]> {
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

export async function getNetworkFees(): Promise<Fees> {
    const response = await fetch(`${mempoolApiUrl}/api/v1/fees/recommended`);
    if (!response.ok) {
        const err = await response.text();
        throw new Error(err);
    } else {
        return await response.json();
    }
}
async function test() {
    const utxo = await getUTXOs("tb1pdseu8mek0m8kwqhffgk0amzmejext02g8qwn09jsfwdrl8zdzpvs2eget3");
    console.log("🚀 ~ main ~ utxo:", utxo)

    const balance = await getAddressBalance("tb1pdseu8mek0m8kwqhffgk0amzmejext02g8qwn09jsfwdrl8zdzpvs2eget3")
    console.log("🚀 ~ main ~ balance:", balance)

    // const fee = await getNetworkFees();
    // console.log("🚀 ~ main ~ fee:", fee)

    const wallet = initWallet();
    console.log("🚀 ~ main ~ wallet:", wallet)

}