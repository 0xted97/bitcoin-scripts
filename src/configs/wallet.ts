import { networks } from "bitcoinjs-lib";
import * as bitcoin from "bitcoinjs-lib";
import * as bip32Factory from "bip32";
import * as bip39 from "bip39";
import * as ecc from 'tiny-secp256k1';
import { toXOnly } from "bitcoinjs-lib/src/psbt/bip371";

import { config } from 'dotenv';
import { broadcast, getBlockHeight } from "../utils/blockstream.utils";
import { getNetworkFees } from "../test-p2tr";
config();

bitcoin.initEccLib(ecc as any);
export const initWallet = async () => {
    const bip32 = bip32Factory.BIP32Factory(ecc)
    const network = networks.testnet;
    const mnemonic = process.env.NEXT_MNEMONIC as string;

    // Values taken from BIP86 document
    const xprv =
        'xprv9s21ZrQH143K3GJpoapnV8SFfukcVBSfeCficPSGfubmSFDxo1kuHnLisriDvSnRRuL2Qrg5ggqHKNVpxR86QEC8w35uxmGoggxtQTPvfUu';
    const path = `m/86'/0'/0'/0/0`; // Path to first child of receiving wallet on first account

    // Verify the above (Below is no different than other HD wallets)
    const seed = await bip39.mnemonicToSeed(mnemonic);
    const rootKey = bip32.fromSeed(seed);
    const childNode = rootKey.derivePath(path);
    const childNodeXOnlyPubkey = toXOnly(childNode.publicKey);
    const internalPubkey = Buffer.from(
        childNodeXOnlyPubkey.toString('hex'),
        'hex');


    
    const { address, output } = bitcoin.payments.p2tr({
        internalPubkey,
        network,
    });
    console.log("🚀 ~ initWal ~ output:", output?.toString("hex"))
    console.log("🚀 ~ initWal ~ address:", address?.toString())

    const tweakedChildNode = childNode.tweak(
        bitcoin.crypto.taggedHash('TapTweak', childNodeXOnlyPubkey),
    );

    console.log("🚀 ~ initWal ~ childNodeXOnlyPubkey:", childNodeXOnlyPubkey.toString("hex"))
    console.log("🚀 ~ initWal ~ tweakedChildNode:", tweakedChildNode.publicKey.toString("hex"))


    const feeRate = await getNetworkFees();


    // amount from faucet
    const utxoInAmount = 98846;
    const sendAmount = 1500;
    
    // amount to send
    // Send some sats to the address via faucet. Get the hash and index. (txid/vout)

    const psbt = new bitcoin.Psbt({ network });
   
    psbt.addInput({
        hash: "3a105e486e45406c1246e53b7183d97ad9a67fa3b2b058a1f0753937c3f95491",
        index: 1,
        witnessUtxo: { value: utxoInAmount, script: output! },
        tapInternalKey: childNodeXOnlyPubkey
    });
    psbt.addOutput({
        value: sendAmount,
        address: address || ""
    });

    const blockHeight = await getBlockHeight();
    console.log("🚀 ~ initWal ~ blockHeight:", blockHeight)

    // const txSize = psbt.data.globalMap.unsignedTx.toBuffer().length + 10;
    // const fee = feeRate.minimumFee * txSize;
    const fee = 154;
    
    psbt.addOutput({
        value: utxoInAmount - sendAmount - fee,
        address: address || "",
    });
    
    
    psbt.setLocktime(blockHeight + 3);
    psbt.signInput(0, tweakedChildNode);
    psbt.finalizeAllInputs();
    const tx = psbt.extractTransaction();
    
    console.log(`Broadcasting Transaction Hex: ${tx.toHex()}`);
    const txid = await broadcast(tx.toHex());
    console.log(`Success! Txid is ${txid}`);







}
