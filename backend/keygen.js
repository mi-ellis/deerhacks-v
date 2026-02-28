const { Keypair } = require('@solana/web3.js');
const bs58 = require('bs58').default || require('bs58');

// Generate a brand new keypair
const keypair = Keypair.generate();

console.log("--- SAVE THIS INFO ---");
console.log("Public Key (Wallet Address):", keypair.publicKey.toBase58());
console.log("Private Key (Secret Key):", bs58.encode(keypair.secretKey));
console.log("-----------------------");