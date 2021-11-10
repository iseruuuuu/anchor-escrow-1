import * as anchor from "@project-serum/anchor";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, Token } from "@solana/spl-token";
import { assert } from "chai";

describe("anchor-escrow", () => {
  const provider = anchor.Provider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.AnchorEscrow;

  let mintA = null;
  let mintB = null;
  let initializerTokenAccountA = null;
  let initializerTokenAccountB = null;
  let takerTokenAccountA = null;
  let takerTokenAccountB = null;

  let vault_account_pda = null;
  let vault_account_bump = null;
  let vault_authority_pda = null;

  const takerAmount = 1000;
  const initializerAmount = 500;

  // メインアカウントにSOLをAirdropするためのアカウント
  const payer = anchor.web3.Keypair.generate();
  // 今回の主役のアカウント。送る側のアカウント。
  const initializerMainAccount = anchor.web3.Keypair.generate();
  // 今回の主役のアカウント。受け取る側のアカウント。
  const tokerMainAccount = anchor.web3.Keypair.generate();
  // Tokenアカウントを作成するアカウント。
  const mintAuthority = anchor.web3.Keypair.generate();
  // escrowアカウント
  const escrowAccount = anchor.web3.Keypair.generate();

  // Escrowをテストするための初期状態のセットアップ
  it("Initialize escrow state", async () => {
    await provider.connection.confirmTransaction(
      await provider.connection.requestAirdrop(payer.publicKey, 10000000000),
      "confirmed"
    );

    // 送受信するためのlamportsをinitializerとtakerのそれぞれアカウントへ送金
    await provider.send(
      (() => {
        const tx = new Transaction();
        tx.add(
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: initializerMainAccount.publicKey,
            lamports: 1000000000,
          }),
          SystemProgram.transfer({
            fromPubkey: payer.publicKey,
            toPubkey: tokerMainAccount.publicKey,
            lamports: 1000000000,
          })
        );
        return tx;
      })(),
      [payer]
    );

    // payerがminterにmintの許可を与える
    mintA = await Token.createMint(
      provider.connection,
      payer, // このアカウントの作成者
      mintAuthority.publicKey, // 今後mintするアカウント
      null,
      0,
      TOKEN_PROGRAM_ID
    );
    mintB = await Token.createMint(provider.connection, payer, mintAuthority.publicKey, null, 0, TOKEN_PROGRAM_ID);

    // トークンAのトークンアカウントを作成。initializerにトークンAのトークンアカウントをアサインする
    initializerTokenAccountA = await mintA.createAccount(initializerMainAccount.publicKey);
    // トークンBのトークンアカウントを作成。initializerにトークンBのトークンアカウントをアサインする
    initializerTokenAccountB = await mintB.createAccount(initializerMainAccount.publicKey);

    // トークンAのトークンアカウントを作成。takerにトークンAのトークンアカウントをアサインする
    takerTokenAccountA = await mintA.createAccount(tokerMainAccount.publicKey);
    // トークンBのトークンアカウントを作成。takerにトークンBのトークンアカウントをアサインする
    takerTokenAccountB = await mintB.createAccount(tokerMainAccount.publicKey);

    // トークンAをinitializerにinitializerAmount枚発行
    await mintA.mintTo(initializerTokenAccountA, mintAuthority.publicKey, [mintAuthority], initializerAmount);
    // トークンBをtakerにtakerAmount枚発行
    await mintB.mintTo(takerTokenAccountB, mintAuthority.publicKey, [mintAuthority], takerAmount);

    // トークンがちゃんと発行されているかを確認するテスト
    let _initializerTokenAccountA = await mintA.getAccountInfo(initializerTokenAccountA);
    let _takerTokenAccountB = await mintB.getAccountInfo(takerTokenAccountB);
    assert.ok(_initializerTokenAccountA.amount.toNumber() === initializerAmount);
    assert.ok(_takerTokenAccountB.amount.toNumber() === takerAmount);
  });

  // initializerTokenAccountからVaultにTokenを送信する
  // 何故PDAが必要か？
  // => initializerMainAccountが[initializerTokenAccount]から[Vault]にTokenを送信する。この時署名する必要があるがinitializerMainAccountは署名できない。なのでPDAを使って署名する。
  it("Initialize escrow", async () => {
    // PDA keyの作成
    // pdaの方はPublicKey, bumpの方はnum
    const [_vault_account_pda, _vault_account_bump] = await PublicKey.findProgramAddress(
      // このseedを使ってProgram側ではkeyを復元する
      [Buffer.from(anchor.utils.bytes.utf8.encode("token-seed"))],
      program.id
    );
    vault_account_pda = _vault_account_pda;
    vault_account_bump = _vault_account_bump;

    // PDA authorityの作成
    // これ何？
    const [_vault_authority_pda, _vault_authority_bump] = await PublicKey.findProgramAddress(
      // このseedを使ってProgram側ではkeyを復元する
      [Buffer.from(anchor.utils.bytes.utf8.encode("escrow"))],
      program.id
    );
    vault_authority_pda = _vault_authority_pda;

    await program.rpc.initializeEscrow(
      // 一応渡してるがProgramの方では使われてないっぽい
      vault_account_bump,
      // anchor.BN(num)はBigNumberのラッパー
      new anchor.BN(initializerAmount),
      new anchor.BN(takerAmount),
      // context
      // #derive[Accounts]で定義したものと同じcontextを用意する
      {
        // initializeEscrowで必要なアカウントとか
        accounts: {
          initializer: initializerMainAccount.publicKey,
          vaultAccount: vault_account_pda,
          mint: mintA.publicKey,
          initializerDepositTokenAccount: initializerTokenAccountA,
          initializerReceiveTokenAccount: initializerTokenAccountB,
          escrowAccount: escrowAccount.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
          tokenProgram: TOKEN_PROGRAM_ID,
        },
        instructions: [await program.account.escrowAccount.createInstruction(escrowAccount)],
        signers: [escrowAccount, initializerMainAccount],
      }
    );

    let _vault = await mintA.getAccountInfo(vault_account_pda);
    let _escrowAccount = await program.account.escrowAccount.fetch(escrowAccount.publicKey);

    // これは何？ => initializerMainAccountからAuthorityをvault(PDA)にセットされてるかの確認
    assert.ok(_vault.owner.equals(vault_authority_pda));
    assert.ok(_escrowAccount.initializeKey.equals(initializerMainAccount.publicKey));
    assert.ok(_escrowAccount.initializerAmount.toNumber() == initializerAmount);
    assert.ok(_escrowAccount.takerAmount.toNumber() == takerAmount);
    assert.ok(_escrowAccount.initializerDepositTokenAccount.equals(initializerTokenAccountA));
    assert.ok(_escrowAccount.initializerReceiveTokenAccount.equals(initializerTokenAccountB));
  });
});
