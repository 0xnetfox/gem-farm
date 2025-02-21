import * as anchor from '@project-serum/anchor';
import { BN, Idl, Program } from '@project-serum/anchor';
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { GemFarm } from '../types/gem_farm';
import {getPkOf, isKp} from '../gem-common';
import {
  findGdrPDA,
  findGemBoxPDA,
  findRarityPDA,
  findVaultAuthorityPDA,
  findVaultPDA,
  findWhitelistProofPDA,
  GemBankClient,
  WhitelistType,
} from '../gem-bank';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  findAuthorizationProofPDA,
  findFarmAuthorityPDA,
  findFarmerPDA,
  findFarmTreasuryPDA,
  findRewardsPotPDA,
} from './gem-farm.pda';
import { PROGRAM_ID as AUTH_PROG_ID } from '@metaplex-foundation/mpl-token-auth-rules/dist/src/generated';
import { PROGRAM_ID as TMETA_PROG_ID } from '@metaplex-foundation/mpl-token-metadata/dist/src/generated';

export const feeAccount = new PublicKey(
  '2xhBxVVuXkdq2MRKerE9mr2s1szfHSedy21MVqf8gPoM'
);

//acts as an enum
export const RewardType = {
  Variable: { variable: {} },
  Fixed: { fixed: {} },
};

export interface FarmConfig {
  minStakingPeriodSec: BN;
  cooldownPeriodSec: BN;
  unstakingFeeLamp: BN;
}

export interface MaxCounts {
  maxFarmers: number;
  maxGems: number;
  maxRarityPoints: number;
}

export interface TierConfig {
  rewardRate: BN;
  requiredTenure: BN;
}

export interface FixedRateSchedule {
  baseRate: BN;
  tier1: TierConfig | null;
  tier2: TierConfig | null;
  tier3: TierConfig | null;
  denominator: BN;
}

export interface FixedRateConfig {
  schedule: FixedRateSchedule;
  amount: BN;
  durationSec: BN;
}

export interface VariableRateConfig {
  amount: BN;
  durationSec: BN;
}

export interface RarityConfig {
  mint: PublicKey;
  rarityPoints: number;
}

export class GemFarmClient extends GemBankClient {
  farmProgram!: anchor.Program<GemFarm>;

  constructor(
    conn: Connection,
    wallet: anchor.Wallet,
    farmIdl?: Idl,
    farmProgramId?: PublicKey,
    bankIdl?: Idl,
    bankProgramId?: PublicKey
  ) {
    super(conn, wallet, bankIdl, bankProgramId);
    this.setFarmProgram(farmIdl, farmProgramId);
  }

  setFarmProgram(idl?: Idl, programId?: PublicKey) {
    //instantiating program depends on the environment
    if (idl && programId) {
      //means running in prod
      this.farmProgram = new anchor.Program<GemFarm>(
        idl as any,
        programId,
        this.provider
      );
    } else {
      //means running inside test suite
      this.farmProgram = anchor.workspace.GemFarm as Program<GemFarm>;
    }
  }

  // --------------------------------------- fetch deserialized accounts

  async fetchFarmAcc(farm: PublicKey) {
    return this.farmProgram.account.farm.fetch(farm);
  }

  async fetchFarmerAcc(farmer: PublicKey) {
    return this.farmProgram.account.farmer.fetch(farmer);
  }

  async fetchAuthorizationProofAcc(authorizationProof: PublicKey) {
    return this.farmProgram.account.authorizationProof.fetch(
      authorizationProof
    );
  }

  async fetchTokenAcc(rewardMint: PublicKey, rewardAcc: PublicKey) {
    return this.deserializeTokenAccount(rewardMint, rewardAcc);
  }

  async fetchTreasuryBalance(farm: PublicKey) {
    const [treasury] = await findFarmTreasuryPDA(farm);
    return this.getBalance(treasury);
  }

  // --------------------------------------- get all PDAs by type
  //https://project-serum.github.io/anchor/ts/classes/accountclient.html#all

  async fetchAllFarmPDAs(manager?: PublicKey) {
    const filter = manager
      ? [
          {
            memcmp: {
              offset: 10, //need to prepend 8 bytes for anchor's disc
              bytes: manager.toBase58(),
            },
          },
        ]
      : [];
    const pdas = await this.farmProgram.account.farm.all(filter);
    console.log(`found a total of ${pdas.length} farm PDAs`);
    return pdas;
  }

  async fetchAllFarmerPDAs(farm?: PublicKey, identity?: PublicKey) {
    const filter: any = [];
    if (farm) {
      filter.push({
        memcmp: {
          offset: 8, //need to prepend 8 bytes for anchor's disc
          bytes: farm.toBase58(),
        },
      });
    }
    if (identity) {
      filter.push({
        memcmp: {
          offset: 40, //need to prepend 8 bytes for anchor's disc
          bytes: identity.toBase58(),
        },
      });
    }
    const pdas = await this.farmProgram.account.farmer.all(filter);
    console.log(`found a total of ${pdas.length} farmer PDAs`);
    return pdas;
  }

  async fetchAllAuthProofPDAs(farm?: PublicKey, funder?: PublicKey) {
    const filter: any = [];
    if (farm) {
      filter.push({
        memcmp: {
          offset: 40, //need to prepend 8 bytes for anchor's disc
          bytes: farm.toBase58(),
        },
      });
    }
    if (funder) {
      filter.push({
        memcmp: {
          offset: 8, //need to prepend 8 bytes for anchor's disc
          bytes: funder.toBase58(),
        },
      });
    }
    const pdas = await this.farmProgram.account.authorizationProof.all(filter);
    console.log(`found a total of ${pdas.length} authorized funders`);
    return pdas;
  }

  // --------------------------------------- core ixs

  async initFarm(
    farm: Keypair,
    farmManager: PublicKey | Keypair,
    payer: PublicKey | Keypair,
    bank: Keypair,
    rewardAMint: PublicKey,
    rewardAType: any, //RewardType instance
    rewardBMint: PublicKey,
    rewardBType: any, //RewardType instance
    farmConfig: FarmConfig,
    maxCounts?: MaxCounts
  ) {
    const [farmAuth, farmAuthBump] = await findFarmAuthorityPDA(farm.publicKey);
    const [farmTreasury, farmTreasuryBump] = await findFarmTreasuryPDA(
      farm.publicKey
    );
    const [rewardAPot, rewardAPotBump] = await findRewardsPotPDA(
      farm.publicKey,
      rewardAMint
    );
    const [rewardBPot, rewardBPotBump] = await findRewardsPotPDA(
      farm.publicKey,
      rewardBMint
    );

    const signers = [farm, bank];
    if (isKp(farmManager)) signers.push(<Keypair>farmManager);

    console.log('starting farm at', farm.publicKey.toBase58());

    const txSig = await this.farmProgram.methods
      .initFarm(
        farmAuthBump,
        farmTreasuryBump,
        rewardAType,
        rewardBType,
        farmConfig,
        maxCounts ?? null,
        farmTreasury
      )
      .accounts({
        farm: farm.publicKey,
        farmManager: getPkOf(farmManager),
        farmAuthority: farmAuth,
        payer: getPkOf(payer),
        feeAcc: feeAccount,
        rewardAPot,
        rewardAMint,
        rewardBPot,
        rewardBMint,
        bank: bank.publicKey,
        gemBank: this.bankProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers(signers)
      .rpc();

    return {
      farmAuth,
      farmAuthBump,
      farmTreasury,
      farmTreasuryBump,
      rewardAPot,
      rewardAPotBump,
      rewardBPot,
      rewardBPotBump,
      txSig,
    };
  }

  async updateFarm(
    farm: PublicKey,
    farmManager: PublicKey | Keypair,
    config: FarmConfig | null = null,
    newManager: PublicKey | null = null,
    maxCounts?: MaxCounts
  ) {
    const signers = [];
    if (isKp(farmManager)) signers.push(<Keypair>farmManager);

    console.log('updating farm');
    const txSig = await this.farmProgram.methods
      .updateFarm(config, newManager, maxCounts ?? null)
      .accounts({
        farm,
        farmManager: getPkOf(farmManager),
      })
      .signers(signers)
      .rpc();

    return { txSig };
  }

  async payoutFromTreasury(
    farm: PublicKey,
    farmManager: PublicKey | Keypair,
    destination: PublicKey,
    lamports: BN
  ) {
    const [farmAuth, farmAuthBump] = await findFarmAuthorityPDA(farm);
    const [farmTreasury, farmTreasuryBump] = await findFarmTreasuryPDA(farm);

    const signers = [];
    if (isKp(farmManager)) signers.push(<Keypair>farmManager);

    console.log('paying out from treasury', farmTreasury.toBase58());
    const txSig = await this.farmProgram.methods
      .payoutFromTreasury(farmAuthBump, farmTreasuryBump, lamports)
      .accounts({
        farm,
        farmManager: getPkOf(farmManager),
        farmAuthority: farmAuth,
        farmTreasury,
        destination,
        systemProgram: SystemProgram.programId,
      })
      .signers(signers)
      .rpc();

    return {
      farmAuth,
      farmAuthBump,
      farmTreasury,
      farmTreasuryBump,
      txSig,
    };
  }

  async addToBankWhitelist(
    farm: PublicKey,
    farmManager: PublicKey | Keypair,
    addressToWhitelist: PublicKey,
    whitelistType: WhitelistType
  ) {
    const farmAcc = await this.fetchFarmAcc(farm);

    const [farmAuth, farmAuthBump] = await findFarmAuthorityPDA(farm);
    const [whitelistProof, whitelistProofBump] = await findWhitelistProofPDA(
      farmAcc.bank,
      addressToWhitelist
    );

    const signers = [];
    if (isKp(farmManager)) signers.push(<Keypair>farmManager);

    console.log(`adding ${addressToWhitelist.toBase58()} to whitelist`);
    const txSig = await this.farmProgram.methods
      .addToBankWhitelist(farmAuthBump, whitelistType)
      .accounts({
        farm,
        farmManager: getPkOf(farmManager),
        farmAuthority: farmAuth,
        bank: farmAcc.bank,
        addressToWhitelist,
        whitelistProof,
        systemProgram: SystemProgram.programId,
        gemBank: this.bankProgram.programId,
      })
      .signers(signers)
      .rpc();

    return {
      farmAuth,
      farmAuthBump,
      whitelistProof,
      whitelistProofBump,
      txSig,
    };
  }

  async removeFromBankWhitelist(
    farm: PublicKey,
    farmManager: PublicKey | Keypair,
    addressToRemove: PublicKey
  ) {
    const farmAcc = await this.fetchFarmAcc(farm);

    const [farmAuth, farmAuthBump] = await findFarmAuthorityPDA(farm);
    const [whitelistProof, whitelistProofBump] = await findWhitelistProofPDA(
      farmAcc.bank,
      addressToRemove
    );

    const signers = [];
    if (isKp(farmManager)) signers.push(<Keypair>farmManager);

    console.log(`removing ${addressToRemove.toBase58()} from whitelist`);
    const txSig = await this.farmProgram.methods
      .removeFromBankWhitelist(farmAuthBump, whitelistProofBump)
      .accounts({
        farm,
        farmManager: getPkOf(farmManager),
        farmAuthority: farmAuth,
        bank: farmAcc.bank,
        addressToRemove,
        whitelistProof,
        gemBank: this.bankProgram.programId,
      })
      .signers(signers)
      .rpc();

    return {
      farmAuth,
      farmAuthBump,
      whitelistProof,
      whitelistProofBump,
      txSig,
    };
  }

  // --------------------------------------- farmer ops ixs

  async initFarmer(
    farm: PublicKey,
    farmerIdentity: PublicKey | Keypair,
    payer: PublicKey | Keypair
  ) {
    const {
      farmer,
      farmerBump,
      vault,
      vaultBump,
      vaultAuth,
      vaultAuthBump,
      builder,
    } = await this.buildInitFarmer(farm, farmerIdentity, payer);

    const txSig = await builder.rpc();

    return {
      farmer,
      farmerBump,
      vault,
      vaultBump,
      vaultAuth,
      vaultAuthBump,
      txSig,
    };
  }

  async buildInitFarmer(
    farm: PublicKey,
    farmerIdentity: PublicKey | Keypair,
    payer: PublicKey | Keypair
  ) {
    const identityPk = isKp(farmerIdentity)
      ? (<Keypair>farmerIdentity).publicKey
      : <PublicKey>farmerIdentity;

    const farmAcc = await this.fetchFarmAcc(farm);

    const [farmer, farmerBump] = await findFarmerPDA(farm, identityPk);
    const [vault, vaultBump] = await findVaultPDA(farmAcc.bank, identityPk);
    const [vaultAuth, vaultAuthBump] = await findVaultAuthorityPDA(vault); //nice-to-have

    const signers = [];
    if (isKp(farmerIdentity)) signers.push(<Keypair>farmerIdentity);
    if (isKp(payer)) signers.push(<Keypair>payer);

    console.log('adding farmer', identityPk.toBase58());
    const builder = this.farmProgram.methods
      .initFarmer()
      .accounts({
        farm,
        farmer,
        identity: identityPk,
        payer: getPkOf(payer),
        feeAcc: feeAccount,
        bank: farmAcc.bank,
        vault,
        gemBank: this.bankProgram.programId,
        systemProgram: SystemProgram.programId,
      })
      .signers(signers);

    return {
      farmer,
      farmerBump,
      vault,
      vaultBump,
      vaultAuth,
      vaultAuthBump,
      builder,
    };
  }

  async stakeCommon(
    farm: PublicKey,
    farmerIdentity: PublicKey | Keypair,
    unstake = false,
    skipRewards = false
  ) {
    const {
      farmer,
      farmerBump,
      vault,
      vaultBump,
      farmAuth,
      farmAuthBump,
      farmTreasury,
      farmTreasuryBump,
      builder,
    } = await this.buildStakeCommon(farm, farmerIdentity, unstake, skipRewards);

    const txSig = await builder.rpc();

    return {
      farmer,
      farmerBump,
      vault,
      vaultBump,
      farmAuth,
      farmAuthBump,
      farmTreasury,
      farmTreasuryBump,
      txSig,
    };
  }

  async buildStakeCommon(
    farm: PublicKey,
    farmerIdentity: PublicKey | Keypair,
    unstake = false,
    skipRewards = false
  ) {
    const identityPk = isKp(farmerIdentity)
      ? (<Keypair>farmerIdentity).publicKey
      : <PublicKey>farmerIdentity;

    const farmAcc = await this.fetchFarmAcc(farm);

    const [farmer, farmerBump] = await findFarmerPDA(farm, identityPk);
    const [vault, vaultBump] = await findVaultPDA(farmAcc.bank, identityPk);
    const [farmAuth, farmAuthBump] = await findFarmAuthorityPDA(farm);
    const [farmTreasury, farmTreasuryBump] = await findFarmTreasuryPDA(farm);

    const signers = [];
    if (isKp(farmerIdentity)) signers.push(<Keypair>farmerIdentity);

    const builder = unstake
      ? await this.farmProgram.methods
          .unstake(farmAuthBump, farmTreasuryBump, farmerBump, skipRewards)
          .accounts({
            farm,
            farmer,
            farmTreasury,
            identity: identityPk,
            bank: farmAcc.bank,
            vault,
            farmAuthority: farmAuth,
            gemBank: this.bankProgram.programId,
            systemProgram: SystemProgram.programId,
            feeAcc: feeAccount,
          })
          .signers(signers)
      : await this.farmProgram.methods
          .stake(farmAuthBump, farmerBump)
          .accounts({
            farm,
            farmer,
            identity: identityPk,
            bank: farmAcc.bank,
            vault,
            farmAuthority: farmAuth,
            gemBank: this.bankProgram.programId,
            feeAcc: feeAccount,
            systemProgram: SystemProgram.programId,
          })
          .signers(signers);

    return {
      farmer,
      farmerBump,
      vault,
      vaultBump,
      farmAuth,
      farmAuthBump,
      farmTreasury,
      farmTreasuryBump,
      builder,
    };
  }

  async stake(farm: PublicKey, farmerIdentity: PublicKey | Keypair) {
    return this.stakeCommon(farm, farmerIdentity, false);
  }

  async unstake(
    farm: PublicKey,
    farmerIdentity: PublicKey | Keypair,
    skipRewards = false
  ) {
    return this.stakeCommon(farm, farmerIdentity, true, skipRewards);
  }

  async claim(
    farm: PublicKey,
    farmerIdentity: PublicKey | Keypair,
    rewardAMint: PublicKey,
    rewardBMint: PublicKey
  ) {
    const {
      farmAuth,
      farmAuthBump,
      farmer,
      farmerBump,
      potA,
      potABump,
      potB,
      potBBump,
      rewardADestination,
      rewardBDestination,
      builder
    } = await this.buildClaim(farm, farmerIdentity, rewardAMint, rewardBMint);

    const txSig = await builder.rpc();

    return {
      farmAuth,
      farmAuthBump,
      farmer,
      farmerBump,
      potA,
      potABump,
      potB,
      potBBump,
      rewardADestination,
      rewardBDestination,
      txSig,
    };
  }

  async buildClaim(
    farm: PublicKey,
    farmerIdentity: PublicKey | Keypair,
    rewardAMint: PublicKey,
    rewardBMint: PublicKey
  ) {
  const identityPk = isKp(farmerIdentity)
        ? (<Keypair>farmerIdentity).publicKey
        : <PublicKey>farmerIdentity;

    const [farmAuth, farmAuthBump] = await findFarmAuthorityPDA(farm);
    const [farmer, farmerBump] = await findFarmerPDA(farm, identityPk);

    const [potA, potABump] = await findRewardsPotPDA(farm, rewardAMint);
    const [potB, potBBump] = await findRewardsPotPDA(farm, rewardBMint);

    const rewardADestination = await this.findATA(rewardAMint, identityPk);
    const rewardBDestination = await this.findATA(rewardBMint, identityPk);

    const signers = [];
    if (isKp(farmerIdentity)) signers.push(<Keypair>farmerIdentity);

    const builder = await this.farmProgram.methods
        .claim(farmAuthBump, farmerBump, potABump, potBBump)
        .accounts({
          farm,
          farmAuthority: farmAuth,
          farmer,
          identity: identityPk,
          rewardAPot: potA,
          rewardAMint,
          rewardADestination,
          rewardBPot: potB,
          rewardBMint,
          rewardBDestination,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        })
        .signers(signers);

    return {
      farmAuth,
      farmAuthBump,
      farmer,
      farmerBump,
      potA,
      potABump,
      potB,
      potBBump,
      rewardADestination,
      rewardBDestination,
      builder,
    }
  }

  async flashDeposit(
    farm: PublicKey,
    farmerIdentity: PublicKey | Keypair,
    gemAmount: BN,
    gemMint: PublicKey,
    gemSource: PublicKey,
    mintProof?: PublicKey,
    metadata?: PublicKey,
    creatorProof?: PublicKey
  ) {
    const identityPk = isKp(farmerIdentity)
      ? (<Keypair>farmerIdentity).publicKey
      : <PublicKey>farmerIdentity;

    const farmAcc = await this.fetchFarmAcc(farm);

    const [farmer, farmerBump] = await findFarmerPDA(farm, identityPk);
    const [vault, vaultBump] = await findVaultPDA(farmAcc.bank, identityPk);
    const [farmAuth, farmAuthBump] = await findFarmAuthorityPDA(farm);

    const [gemBox, gemBoxBump] = await findGemBoxPDA(vault, gemMint);
    const [GDR, GDRBump] = await findGdrPDA(vault, gemMint);
    const [vaultAuth, vaultAuthBump] = await findVaultAuthorityPDA(vault);
    const [gemRarity, gemRarityBump] = await findRarityPDA(
      farmAcc.bank,
      gemMint
    );

    const remainingAccounts = [];
    if (mintProof)
      remainingAccounts.push({
        pubkey: mintProof,
        isWritable: false,
        isSigner: false,
      });
    if (metadata)
      remainingAccounts.push({
        pubkey: metadata,
        isWritable: false,
        isSigner: false,
      });
    if (creatorProof)
      remainingAccounts.push({
        pubkey: creatorProof,
        isWritable: false,
        isSigner: false,
      });

    const signers: Keypair[] = [];
    if (isKp(farmerIdentity)) signers.push(<Keypair>farmerIdentity);

    console.log('flash depositing on behalf of', identityPk.toBase58());
    const flashDepositIx = await this.farmProgram.instruction.flashDeposit(
      farmerBump,
      vaultAuthBump,
      gemRarityBump,
      gemAmount,
      {
        accounts: {
          farm,
          farmAuthority: farmAuth,
          farmer,
          identity: identityPk,
          bank: farmAcc.bank,
          vault,
          vaultAuthority: vaultAuth,
          gemBox,
          gemDepositReceipt: GDR,
          gemSource,
          gemMint,
          gemRarity,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          gemBank: this.bankProgram.programId,
          feeAcc: feeAccount,
        },
        remainingAccounts,
      }
    );

    //will have no effect on solana networks < 1.9.2
    const extraComputeIx = this.createExtraComputeIx(256000);

    //craft transaction
    let tx = new Transaction({
      feePayer: this.wallet.publicKey,
      recentBlockhash: (await this.conn.getRecentBlockhash()).blockhash,
    });
    tx.add(extraComputeIx);
    tx.add(flashDepositIx);
    tx = await this.wallet.signTransaction(tx);
    if (signers.length > 0) {
      tx.partialSign(...signers);
    }
    const txSig = await this.conn.sendRawTransaction(tx.serialize());

    return {
      farmer,
      farmerBump,
      vault,
      vaultBump,
      farmAuth,
      farmAuthBump,
      gemBox,
      gemBoxBump,
      GDR,
      GDRBump,
      vaultAuth,
      vaultAuthBump,
      txSig,
    };
  }

  async flashDepositPnft(
    farm: PublicKey,
    farmerIdentity: PublicKey | Keypair,
    gemAmount: BN,
    gemMint: PublicKey,
    gemSource: PublicKey,
    mintProof?: PublicKey,
    creatorProof?: PublicKey
  ) {
    const identityPk = isKp(farmerIdentity)
      ? (<Keypair>farmerIdentity).publicKey
      : <PublicKey>farmerIdentity;

    const farmAcc = await this.fetchFarmAcc(farm);

    const [farmer, farmerBump] = await findFarmerPDA(farm, identityPk);
    const [vault, vaultBump] = await findVaultPDA(farmAcc.bank, identityPk);
    const [farmAuth, farmAuthBump] = await findFarmAuthorityPDA(farm);

    const [gemBox, gemBoxBump] = await findGemBoxPDA(vault, gemMint);
    const [GDR, GDRBump] = await findGdrPDA(vault, gemMint);
    const [vaultAuth, vaultAuthBump] = await findVaultAuthorityPDA(vault);
    const [gemRarity, gemRarityBump] = await findRarityPDA(
      farmAcc.bank,
      gemMint
    );

    //pnft
    const {
      meta,
      ownerTokenRecordBump,
      ownerTokenRecordPda,
      destTokenRecordBump,
      destTokenRecordPda,
      ruleSet,
      nftEditionPda,
      authDataSerialized,
    } = await this.prepPnftAccounts({
      nftMint: gemMint,
      destAta: gemBox,
      authData: null, //currently useless
      sourceAta: gemSource,
    });
    const remainingAccounts = [];
    if (!!ruleSet) {
      remainingAccounts.push({
        pubkey: ruleSet,
        isSigner: false,
        isWritable: false,
      });
    }
    if (mintProof)
      remainingAccounts.push({
        pubkey: mintProof,
        isWritable: false,
        isSigner: false,
      });
    if (creatorProof)
      remainingAccounts.push({
        pubkey: creatorProof,
        isWritable: false,
        isSigner: false,
      });

    const signers: Keypair[] = [];
    if (isKp(farmerIdentity)) signers.push(<Keypair>farmerIdentity);

    console.log('(PNFT) flash depositing on behalf of', identityPk.toBase58());
    const flashDepositIx = await this.farmProgram.instruction.flashDepositPnft(
      farmerBump,
      vaultAuthBump,
      gemRarityBump,
      gemAmount,
      !!ruleSet,
      {
        accounts: {
          farm,
          farmAuthority: farmAuth,
          farmer,
          identity: identityPk,
          bank: farmAcc.bank,
          vault,
          vaultAuthority: vaultAuth,
          gemBox,
          gemDepositReceipt: GDR,
          gemSource,
          gemMint,
          gemRarity,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          gemBank: this.bankProgram.programId,
          feeAcc: feeAccount,
          gemMetadata: meta,
          gemEdition: nftEditionPda,
          ownerTokenRecord: ownerTokenRecordPda,
          destTokenRecord: destTokenRecordPda,
          authorizationRulesProgram: AUTH_PROG_ID,
          tokenMetadataProgram: TMETA_PROG_ID,
          instructions: SYSVAR_INSTRUCTIONS_PUBKEY,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        },
        remainingAccounts,
      }
    );

    //will have no effect on solana networks < 1.9.2
    const extraComputeIx = this.createExtraComputeIx(400000);

    //craft transaction
    let tx = new Transaction({
      feePayer: this.wallet.publicKey,
      recentBlockhash: (await this.conn.getRecentBlockhash()).blockhash,
    });
    tx.add(extraComputeIx);
    tx.add(flashDepositIx);
    tx = await this.wallet.signTransaction(tx);
    if (signers.length > 0) {
      tx.partialSign(...signers);
    }
    const txSig = await this.conn.sendRawTransaction(tx.serialize());

    return {
      farmer,
      farmerBump,
      vault,
      vaultBump,
      farmAuth,
      farmAuthBump,
      gemBox,
      gemBoxBump,
      GDR,
      GDRBump,
      vaultAuth,
      vaultAuthBump,
      txSig,
      meta,
      ownerTokenRecordBump,
      ownerTokenRecordPda,
      destTokenRecordBump,
      destTokenRecordPda,
    };
  }

  async refreshFarmer(
    farm: PublicKey,
    farmerIdentity: PublicKey | Keypair,
    reenroll?: boolean
  ) {
    const identityPk = isKp(farmerIdentity)
      ? (<Keypair>farmerIdentity).publicKey
      : <PublicKey>farmerIdentity;

    const [farmer, farmerBump] = await findFarmerPDA(farm, identityPk);

    let txSig;
    if (reenroll !== null && reenroll !== undefined) {
      const signers = [];
      if (isKp(farmerIdentity)) signers.push(<Keypair>farmerIdentity);

      console.log('refreshing farmer (SIGNED)', identityPk.toBase58());
      txSig = await this.farmProgram.methods
        .refreshFarmerSigned(farmerBump, reenroll)
        .accounts({
          farm,
          farmer,
          identity: identityPk,
        })
        .signers(signers)
        .rpc();
    } else {
      console.log('refreshing farmer', identityPk.toBase58());
      txSig = await this.farmProgram.methods
        .refreshFarmer(farmerBump)
        .accounts({
          farm,
          farmer,
          identity: identityPk,
        })
        .rpc();
    }

    return {
      farmer,
      farmerBump,
      txSig,
    };
  }

  // --------------------------------------- funder ops ixs

  async authorizeCommon(
    farm: PublicKey,
    farmManager: PublicKey | Keypair,
    funder: PublicKey,
    deauthorize = false
  ) {
    const [authorizationProof, authorizationProofBump] =
      await findAuthorizationProofPDA(farm, funder);

    const signers = [];
    if (isKp(farmManager)) signers.push(<Keypair>farmManager);

    let txSig;
    if (deauthorize) {
      console.log('DEauthorizing funder', funder.toBase58());
      txSig = await this.farmProgram.methods
        .deauthorizeFunder(authorizationProofBump)
        .accounts({
          farm,
          farmManager: getPkOf(farmManager),
          funderToDeauthorize: funder,
          authorizationProof,
          systemProgram: SystemProgram.programId,
        })
        .signers(signers)
        .rpc();
    } else {
      console.log('authorizing funder', funder.toBase58());
      txSig = await this.farmProgram.methods
        .authorizeFunder()
        .accounts({
          farm,
          farmManager: getPkOf(farmManager),
          funderToAuthorize: funder,
          authorizationProof,
          systemProgram: SystemProgram.programId,
        })
        .signers(signers)
        .rpc();
    }

    return { authorizationProof, authorizationProofBump, txSig };
  }

  async authorizeFunder(
    farm: PublicKey,
    farmManager: PublicKey | Keypair,
    funderToAuthorize: PublicKey
  ) {
    return this.authorizeCommon(farm, farmManager, funderToAuthorize, false);
  }

  async deauthorizeFunder(
    farm: PublicKey,
    farmManager: PublicKey | Keypair,
    funderToDeauthorize: PublicKey
  ) {
    return this.authorizeCommon(farm, farmManager, funderToDeauthorize, true);
  }

  // --------------------------------------- reward ops ixs

  async fundReward(
    farm: PublicKey,
    rewardMint: PublicKey,
    funder: PublicKey | Keypair,
    rewardSource: PublicKey,
    variableRateConfig: VariableRateConfig | null = null,
    fixedRateConfig: FixedRateConfig | null = null
  ) {
    const funderPk = isKp(funder)
      ? (<Keypair>funder).publicKey
      : <PublicKey>funder;

    const [farmAuth, farmAuthBump] = await findFarmAuthorityPDA(farm);
    const [authorizationProof, authorizationProofBump] =
      await findAuthorizationProofPDA(farm, funderPk);
    const [pot, potBump] = await findRewardsPotPDA(farm, rewardMint);

    const signers = [];
    if (isKp(funder)) signers.push(<Keypair>funder);

    console.log('funding reward pot', pot.toBase58());
    const txSig = await this.farmProgram.methods
      .fundReward(
        authorizationProofBump,
        potBump,
        variableRateConfig as any,
        fixedRateConfig as any
      )
      .accounts({
        farm,
        authorizationProof,
        authorizedFunder: funderPk,
        rewardPot: pot,
        rewardSource,
        rewardMint,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers(signers)
      .rpc();

    return {
      farmAuth,
      farmAuthBump,
      authorizationProof,
      authorizationProofBump,
      pot,
      potBump,
      txSig,
    };
  }

  async cancelReward(
    farm: PublicKey,
    farmManager: PublicKey | Keypair,
    rewardMint: PublicKey,
    receiver: PublicKey
  ) {
    const [farmAuth, farmAuthBump] = await findFarmAuthorityPDA(farm);
    const [pot, potBump] = await findRewardsPotPDA(farm, rewardMint);
    const rewardDestination = await this.findATA(rewardMint, receiver);

    const signers = [];
    if (isKp(farmManager)) signers.push(<Keypair>farmManager);

    const txSig = await this.farmProgram.methods
      .cancelReward(farmAuthBump, potBump)
      .accounts({
        farm,
        farmManager: getPkOf(farmManager),
        farmAuthority: farmAuth,
        rewardPot: pot,
        rewardDestination,
        rewardMint,
        receiver,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
        rent: anchor.web3.SYSVAR_RENT_PUBKEY,
      })
      .signers(signers)
      .rpc();

    return {
      farmAuth,
      farmAuthBump,
      pot,
      potBump,
      rewardDestination,
      txSig,
    };
  }

  async lockReward(
    farm: PublicKey,
    farmManager: PublicKey | Keypair,
    rewardMint: PublicKey
  ) {
    const signers = [];
    if (isKp(farmManager)) signers.push(<Keypair>farmManager);

    const txSig = await this.farmProgram.methods
      .lockReward()
      .accounts({
        farm,
        farmManager: getPkOf(farmManager),
        rewardMint,
      })
      .signers(signers)
      .rpc();

    return { txSig };
  }

  // --------------------------------------- rarity

  async addRaritiesToBank(
    farm: PublicKey,
    farmManager: PublicKey | Keypair,
    rarityConfigs: RarityConfig[]
  ) {
    const farmAcc = await this.fetchFarmAcc(farm);
    const bank = farmAcc.bank;

    const [farmAuth, farmAuthBump] = await findFarmAuthorityPDA(farm);

    //prepare rarity configs
    const completeRarityConfigs = [...rarityConfigs];
    const remainingAccounts = [];

    for (const config of completeRarityConfigs) {
      const [gemRarity] = await findRarityPDA(bank, config.mint);
      //add mint
      remainingAccounts.push({
        pubkey: config.mint,
        isWritable: false,
        isSigner: false,
      });
      //add rarity pda
      remainingAccounts.push({
        pubkey: gemRarity,
        isWritable: true,
        isSigner: false,
      });
    }

    const signers = [];
    if (isKp(farmManager)) signers.push(<Keypair>farmManager);

    console.log("adding rarities to farm's bank");
    const txSig = await this.farmProgram.methods
      .addRaritiesToBank(farmAuthBump, completeRarityConfigs)
      .accounts({
        farm,
        farmManager: getPkOf(farmManager),
        farmAuthority: farmAuth,
        bank,
        gemBank: this.bankProgram.programId,
        systemProgram: SystemProgram.programId,
      })
      .remainingAccounts(remainingAccounts)
      .signers(signers)
      .rpc();

    return {
      bank,
      farmAuth,
      farmAuthBump,
      completeRarityConfigs,
      txSig,
    };
  }

  // --------------------------------------- helpers

  //returns "variable" or "fixed"
  parseRewardType(reward: any): string {
    return Object.keys(reward.rewardType)[0];
  }

  //returns "staked" / "unstaked" / "pendingCooldown"
  parseFarmerState(farmer: any): string {
    return Object.keys(farmer.state)[0];
  }

  createExtraComputeIx(newComputeBudget: number): TransactionInstruction {
    const data = Buffer.from(
      Uint8Array.of(
        0,
        ...new BN(newComputeBudget).toArray('le', 4),
        ...new BN(0).toArray('le', 4)
      )
    );

    return new TransactionInstruction({
      keys: [],
      programId: new PublicKey('ComputeBudget111111111111111111111111111111'),
      data,
    });
  }
}
