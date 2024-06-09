import { networks } from "bitcoinjs-lib";

import { Network } from "../configs/types";


const nativeSegwitAddressLength = 42;
const taprootAddressLength = 62;

export const toNetwork = (network: Network): networks.Network => {
  switch (network) {
    case Network.MAINNET:
      return networks.bitcoin;
    case Network.TESTNET:
      return networks.testnet;
    case Network.SIGNET:
      return networks.testnet;
    default:
      throw new Error("Unsupported network");
  }
};

export const isSupportedAddressType = (address: string): boolean => {
  return (
    address.length === nativeSegwitAddressLength ||
    address.length === taprootAddressLength
  );
};

export const isTaproot = (address: string): boolean => {
  return address.length === taprootAddressLength;
};

export const getPublicKeyNoCoord = (pkHex: string): Buffer => {
  const publicKey = Buffer.from(pkHex, "hex");
  return publicKey.subarray(1, 33);
};
