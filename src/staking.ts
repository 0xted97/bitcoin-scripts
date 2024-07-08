
import * as bitcoin from "bitcoinjs-lib";
import { tapleafHash } from "bitcoinjs-lib/src/payments/bip341";
import { Taptree } from "bitcoinjs-lib/src/types";

import * as bip32Factory from "bip32";
import * as bip39 from "bip39";
import * as ecc from 'tiny-secp256k1';
import * as fs from "fs";

import { config } from 'dotenv';
import { toXOnly } from "bitcoinjs-lib/src/psbt/bip371";
import { getNetworkConfig, currentNetwork } from "./configs";
import { createWitness, StakingScriptData, stakingTransaction, unbondingTransaction, withdrawEarlyUnbondedTransaction, withdrawTimelockUnbondedTransaction } from "btc-staking-ts";
import { getPublicKeyNoCoord } from "./utils/helper";
import { broadcast, getBlockHeight, getFundingUTXOs, getTransactionHex, getUTXOs } from "./utils/blockstream.utils";
import { UnbondingPayload } from "./types";
import { params } from "./constants";




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
        publicKeyNoCoordHex: getPublicKeyNoCoord(childNode.publicKey.toString("hex")).toString("hex"),
        scriptPubKeyHex: output!.toString("hex"),
        childNodeXOnlyPubkey: childNodeXOnlyPubkey.toString("hex"),
    };

}

const getCovenants = async () => {
    const mnemonic = process.env.NEXT_MNEMONIC_1 as string;
    const seed = await bip39.mnemonicToSeed(mnemonic);
    const rootKey = bip32.fromSeed(seed);
    const covenantKeys = [];
    const total = 9;
    for (let i = 10; i < 10 + 9; i++) {
        const path = `m/86'/0'/0'/0/${i}`;
        const childNode = rootKey.derivePath(path);
        const childNodeXOnlyPubkey = toXOnly(childNode.publicKey);
        const internalPubkey = Buffer.from(
            childNodeXOnlyPubkey.toString('hex'),
            'hex');
        // Get taproot address
        const covenantTaproot = bitcoin.payments.p2tr({
            internalPubkey,
            network: currentNetwork,
        });
        const { address, output } = covenantTaproot;
        const ecPair = bip32.fromPrivateKey(childNode.privateKey!, childNode.chainCode);
        // console.log("🚀 ~ getCovenants ~ childNode:", childNode.privateKey?.toString("hex"), address?.toString())


        covenantKeys.push({
            ecPair,
            childNode,
            rootKey,
            covenantTaproot,
            path,
            rawPath: `m/86'/0'/0'/0/`,
            address: address!,
            pubkeyHex: childNode.publicKey.toString("hex"),
            pubkeyBuffer: childNode.publicKey,
            publicKeyNoCoord: getPublicKeyNoCoord(childNode.publicKey.toString("hex")),
            publicKeyNoCoordHex: getPublicKeyNoCoord(childNode.publicKey.toString("hex")).toString("hex"),
            scriptPubKeyHex: output!.toString("hex"),
            internalPubkey,
        });
    }

    return {
        covenantKeys,
        covenantThreshold: Math.round(total / 2) + 1,
    };

}

const LEAF_VERSION = 0xc0; // Default leaf version for Taproot

// function tapleafHash(script: Buffer): Buffer {
//     const leafVersion = Buffer.from([LEAF_VERSION]); // Default leaf version for Taproot // 192
//     const scriptLength = Buffer.from([script.length]); // Script length in bytes
//     return bitcoin.crypto.taggedHash("TapLeaf", Buffer.concat([leafVersion, scriptLength, script]));
// }


// Utility function to create a Taproot control block
function createControlBlock(internalPubKey: Buffer, leafHash: Buffer): Buffer {
    const parity = Buffer.from([internalPubKey[0] % 2 === 0 ? 0 : 1]);
    return Buffer.concat([parity, internalPubKey,]);
}


// Utility function to create a TapLeafScript object
function createTapLeafScript(script: Buffer, internalPubKey: Buffer): { controlBlock: Buffer, script: Buffer, leafVersion: number } {
    const leafHash = tapleafHash({
        output: script,
    });

    const controlBlock = createControlBlock(internalPubKey, leafHash);
    return {
        controlBlock,
        script,
        leafVersion: LEAF_VERSION,
    };
}

const getScriptsStaking = async () => {
    const unspendableKeyPathKey = Buffer.from('50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0', 'hex');
    const finalityProvider = await getFinalityProvider();
    const staker = await getStaker();
    const covenants = await getCovenants();
    const { covenantKeys, covenantThreshold } = covenants;
    const { minUnbondingTime, magicBytes, stakingAmount, stakingDuration, unbondingTime } = params;

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

    const unbondingPaths: Buffer[] = [];
    unbondingPaths.push(timelockScript);
    unbondingPaths.push(unbondingScript);
    unbondingPaths.push(slashingScript);

    const timeLockLeafHash = tapleafHash({
        output: timelockScript,
    })
    const unbondingPathLeafHash = tapleafHash({
        output: unbondingScript,
    })
    const slashingLeafHash = tapleafHash({
        output: slashingScript,
    })

    const unbondScriptTree: Taptree = [
        {
            output: slashingScript,
        },
        { output: timelockScript }

    ];

    const unbondTaproot = bitcoin.payments.p2tr({
        internalPubkey: unspendableKeyPathKey,
        scriptTree: unbondScriptTree,
        network: currentNetwork,
    })


    const stakingScriptTree: Taptree = [
        {
            output: slashingScript,
        },
        [{ output: unbondingScript }, { output: timelockScript }],
    ];
    const stakingTaproot = bitcoin.payments.p2tr({
        internalPubkey: unspendableKeyPathKey,
        scriptTree: stakingScriptTree,
        network: currentNetwork,
    })


    // Calculate internal node hash (hash of unbondingHash and timelockHash)
    const internalNodeHash = bitcoin.crypto.sha256(Buffer.concat([unbondingPathLeafHash, timeLockLeafHash]));
    // Calculate root hash (hash of slashingHash and internalNodeHash)
    const rootHash = bitcoin.crypto.sha256(Buffer.concat([slashingLeafHash, internalNodeHash]));

    // Calculate Merkle Proof for unbondingScript (internalNodeHash and slashingHash)
    const merkleProof = [internalNodeHash, slashingLeafHash];
    const version = Buffer.from([0xc0]); // Taproot version byte
    const controlBlock = Buffer.concat([version, unspendableKeyPathKey, ...merkleProof]);


    console.table({
        stakingAddress: stakingTaproot.address?.toString(),
        unbondAddress: unbondTaproot.address?.toString(),
        timeLockLeafHash: timeLockLeafHash.toString("hex"),
        unbondingPathLeafHash: unbondingPathLeafHash.toString("hex"),
        slashingLeafHash: slashingLeafHash.toString("hex"),
    });

    return {
        timelockScript,
        unbondingScript,
        slashingScript,
        dataEmbedScript,
        unbondingTimelockScript,

        unbondingPaths,
        slashingLeafHash,
        timeLockLeafHash,
        unbondingPathLeafHash,

        stakingTaproot,
        unbondTaproot,

        controlBlock
    }
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


async function validateRequestPayloadUnbonding(body: UnbondingPayload) {

    return body;
}

async function validateStakingTransaction(txId: string) {
    // validate staking transaction
    return true;
}

async function getStakingHexFromApi(txId: string): Promise<bitcoin.Transaction> {
    const staking = await getTransactionHex(txId);
    const psbt = bitcoin.Transaction.fromHex(staking);
    return psbt;
}

/**
 * API in Server to request unbonding
 * @param body 
 */
async function requestUnbonding(body: UnbondingPayload) {
    const { staker_signed_signature_hex, staking_tx_hash_hex, unbonding_tx_hash_hex, unbonding_tx_hex } = await validateRequestPayloadUnbonding(body);
    const unbondingTx = bitcoin.Transaction.fromHex(unbonding_tx_hex);
    const stakingTransaction = await getStakingHexFromApi(staking_tx_hash_hex);

    // TODO: Validate ouput index must be 0
    // stakingOutputIndexFromUnbondingTx := unbondingTx.TxIn[0].PreviousOutPoint.Index
    // Mean: input of unbond equals output of staking


    // TODO: expectedUnbondingOutputValue = staking amount - unbonding fee
    // Should be validated


    const stakingTxId = unbondingTx.ins[0].hash.reverse().toString("hex");
    const unbondingOutput = unbondingTx.outs[0];
    const unbondingInput = unbondingTx.ins[0];


    const unbondingExpectedAmount = unbondingOutput.value; // amount - unbond fee = this
    // original witness
    const unbondingWitness = unbondingTx.ins[0].witness;
    await validateStakingTransaction(stakingTxId);
    const { unbondingScript, unbondingPathLeafHash, stakingTaproot, unbondTaproot, controlBlock } = await getScriptsStaking();

    // 5120, 51 is OP_PUSHDATA1, 20 indicate next 32 bytes



    const covenantKeys = await getCovenants();
    const covenantThreshold = covenantKeys.covenantThreshold;
    const covenantSignatures = covenantKeys.covenantKeys.map((c) => {
        // TODO: Get control block

        const psbt = new bitcoin.Psbt({ network: currentNetwork })
        psbt.setLocktime(unbondingTx.locktime)
        psbt.setVersion(unbondingTx.version)


        psbt.addInput({
            hash: unbondingTx.ins[0].hash,
            index: unbondingTx.ins[0].index,
            sequence: unbondingTx.ins[0].sequence,
            witnessUtxo: {
                script: stakingTransaction.outs[0].script,
                value: stakingTransaction.outs[0].value,
            },

            // bip32Derivation: [{
            //     masterFingerprint: c.childNode.fingerprint,
            //     pubkey: c.covenantTaproot.pubkey,
            //     path: c.path,
            // }],
            tapInternalKey: stakingTaproot.internalPubkey,
            tapLeafScript: [{
                leafVersion: LEAF_VERSION,
                script: unbondingScript,
                controlBlock: controlBlock
            }],
        });

        psbt.addOutput({
            script: unbondingOutput.script,
            value: unbondingOutput.value,
        });

        psbt.signInput(0, c.ecPair);
        const input0 = psbt!.data!.inputs[0]
        const schnorrSignature = input0.tapScriptSig ? input0.tapScriptSig[0].signature : "0x";

        psbt.finalizeAllInputs();


        return {
            covenant_pk: c.pubkeyBuffer,
            btc_pk_hex: c.pubkeyHex,
            sig_hex: schnorrSignature.toString("hex"),
        }
    });
    
    const witness = createWitness(
        unbondingWitness,
        covenantSignatures.map((c) => c.covenant_pk),
        covenantSignatures.map((c) => ({ btc_pk_hex: c.btc_pk_hex, sig_hex: c.sig_hex })),
    );

    unbondingTx.setWitness(0, witness);
    console.log("🚀 ~ requestUnbonding ~ unbondingTransaction:", unbondingTx.ins[0])
    console.log("🚀 ~ requestUnbonding ~ unbondingTransaction:", unbondingTx.outs[0])


    const txId = await broadcast(unbondingTx.toHex());
    console.log("🚀 ~ requestUnbonding ~ txId:", txId)

}


async function createUnbonding(index: number): Promise<UnbondingPayload> {
    const finalityProvider = await getFinalityProvider();
    const staker = await getStaker();
    const covenants = await getCovenants();



    const { covenantKeys, covenantThreshold } = covenants;


    const stakingTxData = await getStakingData(index);
    console.log("🚀 ~ createUnbonding ~ stakingTxData:", stakingTxData.txId)

    const { stakingDuration, unbondingTime } = stakingTxData;
    const { unbondingFee } = params;

    const {
        timelockScript,
        unbondingScript,
        slashingScript,
        unbondingTimelockScript,
        dataEmbedScript,
    } = await getScriptsStaking();

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

    const unbondingTx = psbt.extractTransaction()


    const stakerSignature = unbondingTx.ins[0].witness[0].toString("hex");
    console.log("🚀 ~ createUnbonding ~ stakerSignature:", unbondingTx.ins[0].hash.toString("hex"))
    console.log("🚀 ~ createUnbonding ~ stakerSignature:", unbondingTx.ins[0].witness)

    const result: UnbondingPayload = {
        staker_signed_signature_hex: stakerSignature,
        staking_tx_hash_hex: stakingTxData.txId,
        unbonding_tx_hash_hex: unbondingTx.getId(),
        unbonding_tx_hex: unbondingTx.toHex(),
    }


    return result;
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

    const { minUnbondingTime, magicBytes, stakingAmount, stakingDuration, unbondingTime, feeRate } = params;

    const {
        timelockScript,
        unbondingScript,
        slashingScript,
        dataEmbedScript,
        unbondingTimelockScript,
    } = await getScriptsStaking();


    const changeAddress = staker.address;
    const inputUTXOs = await getFundingUTXOs(staker.address, stakingAmount);
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
    // const stake = await createStaking();
    // console.log("🚀 ~ main ~ stake:", stake)
    const payload = await createUnbonding(10);
    const collectCovenantSigs = await requestUnbonding(payload);
    // createWithdrawTimelockUnbonded(1);
}

async function getPubKeys() {
    const staker = await getStaker();
    console.log("🚀 ~ getPubKeys ~ staker:", staker)
    const covenantKeys = await getCovenants();
    console.log("🚀 ~ getPubKeys ~ covenantKeys:", covenantKeys.covenantKeys.map((c) => c.pubkeyHex))
    const finalityProvider = await getFinalityProvider();
    console.log("🚀 ~ getPubKeys ~ finalityProvider:", finalityProvider)

}
main();