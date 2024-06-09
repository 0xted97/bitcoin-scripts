import { networks } from "bitcoinjs-lib";
import * as bitcoin from "bitcoinjs-lib";
import * as bip32Factory from "bip32";
import * as bip39 from "bip39";
import * as ecc from 'tiny-secp256k1';
import * as fs from "fs";

import { config } from 'dotenv';
import { toXOnly } from "bitcoinjs-lib/src/psbt/bip371";
import { getNetworkConfig, currentNetwork } from "./configs";
import { createWitness, StakingScriptData, stakingTransaction, unbondingTransaction, withdrawTimelockUnbondedTransaction } from "btc-staking-ts";
import { getPublicKeyNoCoord } from "./utils/helper";
import { broadcast, getBlockHeight, getFundingUTXOs, getUTXOs } from "./utils/blockstream.utils";



config();

bitcoin.initEccLib(ecc as any);
const bip32 = bip32Factory.BIP32Factory(ecc);

const getFinalityProvider = async () => {
    const mnemonic = process.env.NEXT_MNEMONIC_3 as string;
    const seed = await bip39.mnemonicToSeed(mnemonic);
    const rootKey = bip32.fromSeed(seed);
    const path = `m/86'/0'/0'/0/0`;
    const childNode = rootKey.derivePath(path);
    const childNodeXOnlyPubkey = toXOnly(childNode.publicKey);
    const internalPubkey = Buffer.from(
        childNodeXOnlyPubkey.toString('hex'),
        'hex');
    // Get taproot address
    const { address, output } = bitcoin.payments.p2tr({
        internalPubkey,
        network: currentNetwork,
    });

    return {
        address: address!,
        pubkeyHex: childNode.publicKey.toString("hex"),
        publicKeyNoCoord: getPublicKeyNoCoord(childNode.publicKey.toString("hex")),
        scriptPubKeyHex: output!.toString("hex"),
    };

}

const getStaker = async () => {
    const mnemonic = process.env.NEXT_MNEMONIC_1 as string;
    const seed = await bip39.mnemonicToSeed(mnemonic);
    const rootKey = bip32.fromSeed(seed);
    const path = `m/86'/0'/0'/0/0`;
    const childNode = rootKey.derivePath(path);
    const ecPair = bip32.fromPrivateKey(childNode.privateKey!, childNode.chainCode);
    const childNodeXOnlyPubkey = toXOnly(childNode.publicKey);
    const internalPubkey = Buffer.from(
        childNodeXOnlyPubkey.toString('hex'),
        'hex');

    // Get taproot address
    const { address, output } = bitcoin.payments.p2tr({
        internalPubkey,
        network: currentNetwork,
    });


    const tweakedChildNode = childNode.tweak(
        bitcoin.crypto.taggedHash('TapTweak', childNodeXOnlyPubkey),
    );
    return {
        ecPair,
        signer: tweakedChildNode,
        address: address!,
        pubkeyHex: childNode.publicKey.toString("hex"),
        publicKeyNoCoord: getPublicKeyNoCoord(childNode.publicKey.toString("hex")),
        scriptPubKeyHex: output!.toString("hex"),
        childNodeXOnlyPubkey: childNodeXOnlyPubkey.toString("hex"),
    };

}

const getCovenants = async () => {
    const mnemonic = process.env.NEXT_MNEMONIC_1 as string;
    const seed = await bip39.mnemonicToSeed(mnemonic);
    const rootKey = bip32.fromSeed(seed);
    const covenantKeys = [];
    const total = 3;
    for (let i = 10; i < 10 + 3; i++) {
        const path = `m/86'/0'/0'/0/${i}`;
        const childNode = rootKey.derivePath(path);
        const childNodeXOnlyPubkey = toXOnly(childNode.publicKey);
        const internalPubkey = Buffer.from(
            childNodeXOnlyPubkey.toString('hex'),
            'hex');
        // Get taproot address
        const { address, output } = bitcoin.payments.p2tr({
            internalPubkey,
            network: currentNetwork,
        });
        covenantKeys.push({
            address: address!,
            pubkeyHex: childNode.publicKey.toString("hex"),
            publicKeyNoCoord: getPublicKeyNoCoord(childNode.publicKey.toString("hex")),
            scriptPubKeyHex: output!.toString("hex"),
        });
    }

    return {
        covenantKeys,
        covenantThreshold: Math.round(total / 2) + 1,
    };

}

/**
 * Assuming this is api to get staking data
 * @param index 
 * @returns 
 */
const getStakingData = async (index: number) => {
    const listStakingRaw = fs.readFileSync("./data/stakingTx.json", "utf-8");
    const listStaking = JSON.parse(listStakingRaw);
    console.log("🚀 ~ getStakingData ~ listStaking:", listStaking.length)
    const stakingTx = listStaking[index];
    return stakingTx;
}


const updateStakingDataWithdrawn = async (index: number, withdrawalTx: string) => {
    const listStakingRaw = fs.readFileSync("./data/stakingTx.json", "utf-8");
    let listStaking = JSON.parse(listStakingRaw);

    listStaking[index] = {
        ...listStaking[index],
        withdrawalTx,
    };

    fs.writeFileSync("./data/stakingTx.json", JSON.stringify(listStaking));
    return listStaking;
}



async function createUnbonding(index: number = 0) {
    const finalityProvider = await getFinalityProvider();
    const staker = await getStaker();
    const covenants = await getCovenants();


    const { covenantKeys, covenantThreshold } = covenants;


    const stakingTxData = await getStakingData(index);

    const { stakingDuration, unbondingTime } = stakingTxData;

    const magicBytes: Buffer = Buffer.from("62627434", "hex"); // "bbt4" tag
    const unbondingFee: number = 500;

    const stakingScriptData = new StakingScriptData(
        staker.publicKeyNoCoord,
        [finalityProvider.publicKeyNoCoord],
        covenantKeys.map((c) => c.publicKeyNoCoord),
        covenantThreshold,
        stakingDuration,
        unbondingTime,
        magicBytes,
    );

    const {
        timelockScript,
        unbondingScript,
        slashingScript,
        unbondingTimelockScript,
        dataEmbedScript,
    } = stakingScriptData.buildScripts();

    const stakingTx = bitcoin.Transaction.fromHex(stakingTxData.stakingTx);
    const { psbt } = unbondingTransaction(
        {
            timelockScript,
            unbondingScript,
            slashingScript,
            unbondingTimelockScript,
        },
        stakingTx,
        unbondingFee,
        currentNetwork,
        0,
    );

    psbt.signInput(0, staker.ecPair);
    psbt.finalizeAllInputs();
    const unbondingTx = psbt.extractTransaction();

    const stakerSignature = unbondingTx.ins[0].witness[0].toString("hex");
    console.log("🚀 ~ createUnbonding ~ stakerSignature:", stakerSignature)

}

async function createWithdrawTimelockUnbonded(index: number) {
    const finalityProvider = await getFinalityProvider();
    const staker = await getStaker();
    const covenants = await getCovenants();

    // const utxoTest = await getUTXOs("tb1p84w47y97zpahmptqf4rfqgshgqczda3v23cvvfezp5p2mj6ah55q27xl0c");
    // console.log("🚀 ~ createWithdrawTimelockUnbonded ~ utxoTest:", utxoTest)

    const { covenantKeys, covenantThreshold } = covenants;


    const stakingTxData = await getStakingData(index);

    const { stakingDuration, unbondingTime, feeRate } = stakingTxData;
    console.log("🚀 ~ createWithdrawTimelockUnbonded ~ stakingTxData.txId:", stakingTxData.txId)

    const magicBytes: Buffer = Buffer.from("62627434", "hex"); // "bbt4" tag

    const stakingScriptData = new StakingScriptData(
        staker.publicKeyNoCoord,
        [finalityProvider.publicKeyNoCoord],
        covenantKeys.map((c) => c.publicKeyNoCoord),
        covenantThreshold,
        stakingDuration,
        unbondingTime,
        magicBytes,
    );

    const {
        timelockScript,
        unbondingScript,
        slashingScript,
        unbondingTimelockScript,
        dataEmbedScript,
    } = stakingScriptData.buildScripts();

    const stakingTx = bitcoin.Transaction.fromHex(stakingTxData.stakingTx);
    const unsignedWithdrawalPsbt = withdrawTimelockUnbondedTransaction(
        {
            timelockScript,
            unbondingScript,
            slashingScript,
        },
        stakingTx,
        staker.address,
        currentNetwork,
        feeRate,
        0,
    );
    const psbt = unsignedWithdrawalPsbt.psbt;

    psbt.signInput(0, staker.ecPair);

    psbt.finalizeAllInputs();

    const withdrawalTx = psbt.extractTransaction();

    const txId = await broadcast(withdrawalTx.toHex());
    console.log("🚀 ~ createWithdrawTimelockUnbonded ~ txId:", txId)
    updateStakingDataWithdrawn(index, txId);
}

async function createStaking() {
    const finalityProvider = await getFinalityProvider();
    const staker = await getStaker();
    const covenants = await getCovenants();


    const { covenantKeys, covenantThreshold } = covenants;
    const minUnbondingTime: number = 101;
    const magicBytes: Buffer = Buffer.from("62627434", "hex"); // "bbt4" tag
    const stakingDuration: number = 10;
    const stakingAmount: number = 1249;
    const unbondingTime: number = minUnbondingTime;

    const stakingScriptData = new StakingScriptData(
        staker.publicKeyNoCoord,
        [finalityProvider.publicKeyNoCoord],
        covenantKeys.map((c) => c.publicKeyNoCoord),
        covenantThreshold,
        stakingDuration,
        unbondingTime,
        magicBytes,
    );


    const {
        timelockScript,
        unbondingScript,
        slashingScript,
        dataEmbedScript,
        unbondingTimelockScript,
    } = stakingScriptData.buildScripts();


    const changeAddress = staker.address;
    const inputUTXOs = await getFundingUTXOs(staker.address, stakingAmount);
    const feeRate = 1;
    const lockHeight = await getBlockHeight();

    const unsignedStakingPsbt: { psbt: bitcoin.Psbt, fee: number } = stakingTransaction(
        {
            timelockScript,
            unbondingScript,
            slashingScript,
            dataEmbedScript
        },
        stakingAmount,
        changeAddress,
        inputUTXOs,
        currentNetwork,
        feeRate,
        staker.publicKeyNoCoord,
        lockHeight,
    );
    const { psbt, fee } = unsignedStakingPsbt;
    // const psbtInHex = psbt.toHex();
    psbt.signAllInputs(staker.signer);
    psbt.finalizeAllInputs();
    const stakingTx = psbt.extractTransaction();

    const txId = await broadcast(stakingTx.toHex());
    const result = {
        txId,
        lockHeight,
        minUnbondingTime,
        stakingDuration,
        stakingAmount,
        unbondingTime,
        fee,
        feeRate,
        magicBytes: magicBytes.toString("hex"),
        staker: { staker: staker.address, pubkey: staker.pubkeyHex, childNodeXOnlyPubkey: staker.childNodeXOnlyPubkey, scriptPubKey: staker.scriptPubKeyHex },
        provider: { provider: finalityProvider.address, pubkey: finalityProvider.pubkeyHex, scriptPubKey: finalityProvider.scriptPubKeyHex },
        stakingTx: stakingTx.toHex(),
        timelockScript: timelockScript.toString("hex"),
        unbondingScript: unbondingScript.toString("hex"),
        slashingScript: slashingScript.toString("hex"),
        dataEmbedScript: dataEmbedScript.toString("hex"),
        unbondingTimelockScript: unbondingTimelockScript.toString("hex"),
    }

    const previousStaking = fs.readFileSync("./data/stakingTx.json", "utf-8");
    const previousStakingTx = JSON.parse(previousStaking);
    previousStakingTx.push(result)
    fs.writeFileSync("./data/stakingTx.json", JSON.stringify(previousStakingTx));
    return result;
}

async function main() {
    const stake = await createStaking();
    // console.log("🚀 ~ main ~ stake:", stake)
    createUnbonding(6);
    createWithdrawTimelockUnbonded(6);
    // const tx = bitcoin.Transaction.fromHex("0200000000010176131b3d969e65abdb00b908fbcd128eb8045732ba4b4b5e2a1ba7f714374c380200000000fdffffff03f401000000000000225120539fe5bf403883f88a62c2253e60350f5f545c3c8f8d3f767937e7c434084cc00000000000000000496a476262743400ad7ff9ff8f630a594dc524e6c23d163c62e665fb40d5f2fafb8be66a7c14e9e63207d52ae5aa65120f3c30355d195b0bdf38a8e0d7fef63da42d26cf9ec33288000a8b5c0100000000002251206c33c3ef367ecf6702e94a2cfeec5bccb265bd48381d3796504b9a3f9c4d10590140c51fb79ef2f0a85ecfd2198cd27ff0af5de085d436b81f3de9992cd20a43e34a755e230864839ffc4c4a964cecaded67cba5e445c2800a10ddb10b798db94626bb080300")
}
main();