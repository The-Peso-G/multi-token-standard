import * as ethers from 'ethers'

import { 
  AbstractContract,  
  RevertError, 
  expect,
  encodeMetaTransferFromData,
  encodeMetaBatchTransferFromData,
  encodeMetaApprovalData,
  GasReceiptType, 
  ethSign 
} from './utils'
import * as utils from './utils'

import { toUtf8Bytes, bigNumberify, BigNumber } from 'ethers/utils'

import { ERC1155MetaMintBurnMock } from 'typings/contracts/ERC1155MetaMintBurnMock'
import { ERC1271WalletValidationMock } from 'typings/contracts/ERC1271WalletValidationMock'
import { ERC1155ReceiverMock } from 'typings/contracts/ERC1155ReceiverMock'
import { ERC1155OperatorMock } from 'typings/contracts/ERC1155OperatorMock'
import { ERC20Mock } from 'typings/contracts/ERC20Mock'
import { 
  GasReceipt, 
  TransferSignature, 
  ApprovalSignature, 
  BatchTransferSignature 
} from 'typings/txTypes';

// init test wallets from package.json mnemonic
const web3 = (global as any).web3
  
const {
  wallet: ownerWallet,
  provider: ownerProvider,
  signer: ownerSigner
} = utils.createTestWallet(web3, 0)

const {
  wallet: receiverWallet,
  provider: receiverProvider,
  signer: receiverSigner
} = utils.createTestWallet(web3, 2)

const {
  wallet: operatorWallet,
  provider: operatorProvider,
  signer: operatorSigner
} = utils.createTestWallet(web3, 4)

// Lower polling interval for faster tx send
ownerProvider.pollingInterval = 1000;
operatorProvider.pollingInterval = 1000;
receiverProvider.pollingInterval = 1000;

contract('ERC1155Meta', (accounts: string[]) => {

  const MAXVAL = new BigNumber(2).pow(256).sub(1) // 2**256 - 1
  const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
  const DOMAIN_SEPARATOR_TYPEHASH = '0x035aff83d86937d35b32e04f0ddc6ff469290eef2f1b692d8a815c89404d4749'

  // Pass gas since ganache can't figure it out
  let TX_PARAM = {gasLimit: 2000000}

  let ownerAddress: string
  let receiverAddress: string
  let operatorAddress: string
  let erc1155Abstract: AbstractContract
  let operatorAbstract: AbstractContract

  let erc1155Contract: ERC1155MetaMintBurnMock
  let operatorERC1155Contract: ERC1155MetaMintBurnMock
  let receiverERC1155Contract: ERC1155MetaMintBurnMock


  // load contract abi and deploy to test server
  before(async () => {
    ownerAddress = await ownerWallet.getAddress()
    receiverAddress = await receiverWallet.getAddress()
    operatorAddress = await operatorWallet.getAddress()

    erc1155Abstract = await AbstractContract.fromArtifactName('ERC1155MetaMintBurnMock')
    operatorAbstract = await AbstractContract.fromArtifactName('ERC1155OperatorMock')
  })

  // deploy before each test, to reset state of contract
  beforeEach(async () => {
    erc1155Contract = await erc1155Abstract.deploy(ownerWallet) as ERC1155MetaMintBurnMock 
    operatorERC1155Contract = await erc1155Contract.connect(operatorSigner) as ERC1155MetaMintBurnMock
    receiverERC1155Contract = await erc1155Contract.connect(receiverSigner) as ERC1155MetaMintBurnMock
  })
  


  describe('metaSafeTransferFrom() (Meta) Function', () => {
    let receiverContract: ERC1155ReceiverMock
    let operatorContract: ERC1155OperatorMock
    
    let transferData: string | null = 'Hello from the other side'
    let initBalance = 100;
    let amount = 10;
    let nonce = new BigNumber(0);
    let id = 66;

    let feeTokenID = 666   
    let isGasReceipt: boolean = true;
    let feeTokenInitBalance = new BigNumber(100000000);

    let feeType = 0 // ERC-1155
    let feeTokenAddress : string
    let feeTokenDataERC1155: string | Uint8Array

    let transferObj: TransferSignature;
    let domainHash: string;
    let gasReceipt : GasReceipt | null;
    let data : string;

    let conditions = [
      [transferData, true, 'Gas receipt & transfer data'],
      [null, true, 'Gas receipt w/o transfer data'],
      [transferData, false, 'Transfer data w/o gas receipt '],
      [null, false, 'No Gas receipt & No transfer data']
    ]

    conditions.forEach(function(condition) {
      context(condition[2] as string, () => {

        beforeEach(async () => {

          // Get conditions
          transferData = condition[0] as string | null
          isGasReceipt = condition[1] as boolean

          // Deploy contracts
          let abstract = await AbstractContract.fromArtifactName('ERC1155ReceiverMock')
          receiverContract = await abstract.deploy(ownerWallet) as ERC1155ReceiverMock
          operatorContract = await operatorAbstract.deploy(operatorWallet) as ERC1155OperatorMock

          feeTokenAddress = erc1155Contract.address

          feeTokenDataERC1155 = ethers.utils.defaultAbiCoder.encode(
            ['address', 'uint256', 'uint8'], 
            [feeTokenAddress, feeTokenID, feeType]
          )

          // Gas Receipt
          gasReceipt = {
            gasLimitCallback: 130000,
            gasFee: 30000,
            feeRecipient: operatorAddress,
            feeTokenData: feeTokenDataERC1155,
          }

          // Check if gas receipt is included
          gasReceipt = isGasReceipt ? gasReceipt : null
          
          // Transfer Signature Object
          transferObj = {
            contractAddress: erc1155Contract.address,
            signerWallet: ownerWallet,
            receiver: receiverAddress,
            id: id,
            amount: amount,
            isGasFee: isGasReceipt,
            transferData: transferData === null ? null : toUtf8Bytes(transferData),
            nonce: nonce
          }

          // Mint tokens
          await erc1155Contract.functions.mintMock(ownerAddress, id, initBalance, [])

          // Mint tokens used to pay for gas
          await erc1155Contract.functions.mintMock(ownerAddress, feeTokenID, feeTokenInitBalance, [])
          
          // Domain hash
          domainHash = ethers.utils.keccak256(ethers.utils.solidityPack(
            ['bytes32', 'uint256'], 
            [DOMAIN_SEPARATOR_TYPEHASH, erc1155Contract.address]
          ))

          // Data to pass in transfer method
          data = await encodeMetaTransferFromData(transferObj, domainHash, gasReceipt)
        })

        it("should REVERT if data is 'random", async () => {
          let dataUint8 = toUtf8Bytes("Breakthroughs! over the river! flips and crucifixions! gone down the flood!")
          let data = bigNumberify(dataUint8).toHexString()

          // Check if data lelngth is more than 69
          expect(ethers.utils.arrayify(data).length).to.be.at.least(70)

          const tx = erc1155Contract.functions.metaSafeTransferFrom(ownerAddress, receiverContract.address, id, amount, isGasReceipt, data)
          await expect(tx).to.be.rejectedWith(RevertError());  
        })

        it("should REVERT if contract address is incorrect", async () => {
          // Domain hash
          domainHash = ethers.utils.keccak256(ethers.utils.solidityPack(
            ['bytes32', 'uint256'], 
            [DOMAIN_SEPARATOR_TYPEHASH, receiverContract.address]
          ))
          data = await encodeMetaTransferFromData(transferObj, domainHash, gasReceipt)

          const tx = operatorERC1155Contract.functions.metaSafeTransferFrom(ownerAddress, receiverAddress, id, amount, isGasReceipt, data)
          await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_SIGNATURE") )    
        })

        it("should REVERT if signer address is incorrect", async () => {
          transferObj.signerWallet = operatorWallet;
          data = await encodeMetaTransferFromData(transferObj, domainHash, gasReceipt)

          const tx = operatorERC1155Contract.functions.metaSafeTransferFrom(ownerAddress, receiverAddress, id, amount, isGasReceipt, data)
          await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_SIGNATURE") )  
        })

        it("should REVERT if receiver address is incorrect", async () => {
          transferObj.receiver = ownerAddress;
          data = await encodeMetaTransferFromData(transferObj, domainHash, gasReceipt)

          const tx = operatorERC1155Contract.functions.metaSafeTransferFrom(ownerAddress, receiverAddress, id, amount, isGasReceipt, data)
          await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_SIGNATURE") )  
        })

        it("should REVERT if token id is incorrect", async () => {
          transferObj.id = id+1;
          data = await encodeMetaTransferFromData(transferObj, domainHash, gasReceipt)

          const tx = operatorERC1155Contract.functions.metaSafeTransferFrom(ownerAddress, receiverAddress, id, amount, isGasReceipt, data)
          await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_SIGNATURE") )  
        })

        it("should REVERT if token amount is incorrect", async () => {
          transferObj.amount = amount + 1;
          data = await encodeMetaTransferFromData(transferObj, domainHash, gasReceipt)

          const tx = operatorERC1155Contract.functions.metaSafeTransferFrom(ownerAddress, receiverAddress, id, amount, isGasReceipt, data)
          await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_SIGNATURE") )  
        })

        it("should REVERT if transfer data is incorrect", async () => {
          const sigArgTypes = ['address', 'address', 'address', 'uint256', 'uint256', 'uint256'];
          const txDataTypes = ['bytes', 'bytes'];
        
          let signer = await transferObj.signerWallet.getAddress()
          
          // Packed encoding of transfer signature message
          let sigData = ethers.utils.solidityPack(sigArgTypes, [
            transferObj.contractAddress, signer, transferObj.receiver, transferObj.id, 
            transferObj.amount, transferObj.nonce
          ])

          let transferData = transferObj.transferData == null ? toUtf8Bytes('') : transferObj.transferData
          let goodGasAndTransferData;
          let badGasAndTransferData;

          // Correct and incorrect transferData
          if (isGasReceipt) {
            goodGasAndTransferData = ethers.utils.defaultAbiCoder.encode([GasReceiptType, 'bytes'], [gasReceipt, transferData])
            badGasAndTransferData = ethers.utils.defaultAbiCoder.encode([GasReceiptType, 'bytes'], [gasReceipt, toUtf8Bytes('Goodbyebyebye')])
          } else {
            goodGasAndTransferData = ethers.utils.defaultAbiCoder.encode(['bytes'], [transferData])
            badGasAndTransferData = ethers.utils.defaultAbiCoder.encode(['bytes'], [toUtf8Bytes('Goodbyebyebye')])
          }

          // Encode normally the whole thing
          sigData = ethers.utils.solidityPack(['bytes', 'bytes'], [sigData, goodGasAndTransferData])
        
          // Get signature
          let sig = (await ethSign(transferObj.signerWallet, sigData)).slice(0, -2)
          let paddedNonce = ethers.utils.solidityPack(['uint256'], [transferObj.nonce])
          let ethsig_nonce = sig + paddedNonce.slice(2) + '02' // encode packed the nonce
        
          // PASS BAD DATA
          data = ethers.utils.defaultAbiCoder.encode(txDataTypes, [ethsig_nonce, badGasAndTransferData])

          const tx = operatorERC1155Contract.functions.metaSafeTransferFrom(ownerAddress, receiverAddress, id, amount, isGasReceipt, data)
          await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_SIGNATURE") )
        })

        it("should REVERT if nonce is incorrect", async () => {
          transferObj.nonce = nonce.add(101);
          data = await encodeMetaTransferFromData(transferObj, domainHash, gasReceipt)

          // Nonce higher
          const tx = operatorERC1155Contract.functions.metaSafeTransferFrom(ownerAddress, receiverAddress, id, amount, isGasReceipt, data)
          await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_NONCE") )
          
          // Correct nonce
          transferObj.nonce = nonce
          data = await encodeMetaTransferFromData(transferObj, domainHash, gasReceipt)
          await operatorERC1155Contract.functions.metaSafeTransferFrom(ownerAddress, receiverAddress, id, amount, isGasReceipt, data)
          
          // Nonce lower
          const tx2 = operatorERC1155Contract.functions.metaSafeTransferFrom(ownerAddress, receiverAddress, id, amount, isGasReceipt, data)
          await expect(tx2).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_NONCE") ) 

        })

        it("should PASS if signature is valid", async () => {
          const tx = operatorERC1155Contract.functions.metaSafeTransferFrom(ownerAddress, receiverAddress, id, amount, isGasReceipt, data)
          await expect(tx).to.be.fulfilled
        })

        describe('ERC-1271 Receiver', () => {
          let erc1271WalletValidationMockContract: ERC1271WalletValidationMock
          let ERC1271WalletValidationMockAbstract: AbstractContract

          let erc1271WalletAddress;

          beforeEach( async () => {
            ERC1271WalletValidationMockAbstract = await AbstractContract.fromArtifactName('ERC1271WalletValidationMock')
            erc1271WalletValidationMockContract = await ERC1271WalletValidationMockAbstract.deploy(ownerWallet, [domainHash]) as ERC1271WalletValidationMock
            erc1271WalletAddress = erc1271WalletValidationMockContract.address;

            await erc1155Contract.functions.mintMock(erc1271WalletAddress, id, initBalance, [])
            await erc1155Contract.functions.mintMock(erc1271WalletAddress, feeTokenID, feeTokenInitBalance, [])        
          })

          describe(`EIP-1271 (bytes) signatures (03)`, () => {
            it('should return REVERT if signature is invalid', async () => {
              transferObj.from = erc1271WalletAddress;
              transferObj.signerWallet = receiverWallet;

              data = await encodeMetaTransferFromData(transferObj, domainHash, gasReceipt, '03')
              const tx = operatorERC1155Contract.functions.metaSafeTransferFrom(erc1271WalletAddress, receiverAddress, id, amount, isGasReceipt, data,
                {gasLimit: 2000000}
              )
              await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_SIGNATURE") )
            })

            it('should REVERT if token ID is not 66', async () => {
              let badID = 77
              await erc1155Contract.functions.mintMock(erc1271WalletAddress, badID, initBalance, [])
              transferObj.from = erc1271WalletAddress;
              transferObj.id = badID
              data = await encodeMetaTransferFromData(transferObj, domainHash, gasReceipt, '03')
              const tx = operatorERC1155Contract.functions.metaSafeTransferFrom(erc1271WalletAddress, receiverAddress, id, amount, isGasReceipt, data,
                {gasLimit: 2000000}
              )
              await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_SIGNATURE") ) 
            })

            it('should REVERT if amount is more than 100', async () => {
              await erc1155Contract.functions.mintMock(erc1271WalletAddress, id, 101, [])
              transferObj.from = erc1271WalletAddress;
              transferObj.amount = 101
              data = await encodeMetaTransferFromData(transferObj, domainHash, gasReceipt, '03')
              const tx = operatorERC1155Contract.functions.metaSafeTransferFrom(erc1271WalletAddress, receiverAddress, id, amount, isGasReceipt, data,
                {gasLimit: 2000000}
              )
              await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_SIGNATURE") ) 
            })
    
            it('should PASS if signature is valid', async () => {
              transferObj.from = erc1271WalletAddress;
              data = await encodeMetaTransferFromData(transferObj, domainHash, gasReceipt, '03')
              const tx = operatorERC1155Contract.functions.metaSafeTransferFrom(erc1271WalletAddress, receiverAddress, id, amount, isGasReceipt, data,
                {gasLimit: 2000000}
              )
              await expect(tx).to.be.fulfilled  
            })
          })

          describe(`EIP-1271 (bytes32) signatures (04)`, () => {
            it('should return REVERT if signature is invalid', async () => {
              transferObj.from = erc1271WalletAddress;
              transferObj.signerWallet = receiverWallet;

              data = await encodeMetaTransferFromData(transferObj, domainHash, gasReceipt, '04')
              const tx = operatorERC1155Contract.functions.metaSafeTransferFrom(erc1271WalletAddress, receiverAddress, id, amount, isGasReceipt, data,
                {gasLimit: 2000000}
              )
              await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_SIGNATURE") )
            })
    
            it('should PASS if signature is valid', async () => {
              transferObj.from = erc1271WalletAddress;
              data = await encodeMetaTransferFromData(transferObj, domainHash, gasReceipt, '04')
              const tx = operatorERC1155Contract.functions.metaSafeTransferFrom(erc1271WalletAddress, receiverAddress, id, amount, isGasReceipt, data,
                {gasLimit: 2000000}
              )
              await expect(tx).to.be.fulfilled  
            })
          })
        })

        describe('When signature is valid', () => {

          it('should REVERT if insufficient balance', async () => {
            transferObj.amount = initBalance+1;
            data = await encodeMetaTransferFromData(transferObj, domainHash, gasReceipt)

            const tx = operatorERC1155Contract.functions.metaSafeTransferFrom(ownerAddress, receiverAddress, id, initBalance+1, isGasReceipt, data)
            await expect(tx).to.be.rejectedWith( RevertError("SafeMath#sub: UNDERFLOW") ) 
          })

          it('should REVERT if sending to 0x0', async () => {
            transferObj.receiver = ZERO_ADDRESS;
            data = await encodeMetaTransferFromData(transferObj, domainHash, gasReceipt)

            const tx = operatorERC1155Contract.functions.metaSafeTransferFrom(ownerAddress, ZERO_ADDRESS, id, amount, isGasReceipt, data)
            await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#metaSafeTransferFrom: INVALID_RECIPIENT") ) 
          })

          it('should REVERT if transfer leads to overflow', async () => {
            await erc1155Contract.functions.mintMock(receiverAddress, id, MAXVAL, [])
            const tx = operatorERC1155Contract.functions.metaSafeTransferFrom(ownerAddress, receiverAddress, id, amount, isGasReceipt, data)
            await expect(tx).to.be.rejectedWith( RevertError("SafeMath#add: OVERFLOW") ) 
          })

          it('should REVERT when sending to non-receiver contract', async () => {
            transferObj.receiver = erc1155Contract.address;
            data = await encodeMetaTransferFromData(transferObj, domainHash, gasReceipt)

            const tx = operatorERC1155Contract.functions.metaSafeTransferFrom(ownerAddress, erc1155Contract.address, id, amount, isGasReceipt, data)
            await expect(tx).to.be.rejectedWith(RevertError("ERC1155MetaMintBurnMock: INVALID_METHOD")) 
          })

          it('should REVERT if invalid response from receiver contract', async () => {
            transferObj.receiver = receiverContract.address;
            data = await encodeMetaTransferFromData(transferObj, domainHash, gasReceipt)

            // Force invalid response
            await receiverContract.functions.setShouldReject(true)

            const tx = operatorERC1155Contract.functions.metaSafeTransferFrom(ownerAddress, receiverContract.address, id, amount, isGasReceipt, data)

            await expect(tx).to.be.rejectedWith( RevertError("ERC1155#_callonERC1155Received: INVALID_ON_RECEIVE_MESSAGE") )
          })

          it('should PASS if valid response from receiver contract', async () => {
            transferObj.receiver = receiverContract.address;
            data = await encodeMetaTransferFromData(transferObj, domainHash, gasReceipt, "02")

            const tx = operatorERC1155Contract.functions.metaSafeTransferFrom(ownerAddress, receiverContract.address, id, amount, isGasReceipt, data)
            
            //await expect(tx).to.be.fulfilled
            await expect(tx).to.be.fulfilled
          })


          describe('When gas is reimbursed', () => {

            before(async function () {
              if (!condition[1]){
                this.test!.parent!.pending = true;
                this.skip();
              }
            });
            
            it('should send gas fee to msg.sender is fee recipient ix 0x0', async () => {
              gasReceipt!.feeRecipient = ZERO_ADDRESS;

              data = await encodeMetaTransferFromData(transferObj, domainHash, gasReceipt)

              await receiverERC1155Contract.functions.metaSafeTransferFrom(ownerAddress, receiverAddress, id, amount, isGasReceipt, data)

              let receiverBalance = await erc1155Contract.functions.balanceOf(receiverAddress, feeTokenID)

              expect(gasReceipt!.gasFee).to.be.eql(receiverBalance.toNumber())
            })

            it("should send gas fee to specified fee recipient (if not 0x0), not tx.origin", async () => {
              await receiverERC1155Contract.functions.metaSafeTransferFrom(ownerAddress, receiverAddress, id, amount, isGasReceipt, data)
              let operatorBalance = await erc1155Contract.functions.balanceOf(operatorAddress, feeTokenID)

              expect(gasReceipt!.gasFee).to.be.eql(operatorBalance.toNumber())
            })

            it("should REVERT if gasReceipt is incorrect", async () => {
              const sigArgTypes = ['address', 'address', 'address', 'uint256', 'uint256', 'uint256'];
              const txDataTypes = ['bytes', 'bytes'];
            
              let signer = await transferObj.signerWallet.getAddress()
              
              // Packed encoding of transfer signature message
              let sigData = ethers.utils.solidityPack(sigArgTypes, [
                transferObj.contractAddress, signer, transferObj.receiver, transferObj.id, 
                transferObj.amount, transferObj.nonce
              ])
  
              // Form bad gas receipt
              let badGasReceipt = {...gasReceipt, gasPrice: 109284123}
  
              let transferData = transferObj.transferData == null ? toUtf8Bytes('') : transferObj.transferData
  
              
              // Correct and incorrect transferData
              let goodGasAndTransferData = ethers.utils.defaultAbiCoder.encode([GasReceiptType, 'bytes'], [gasReceipt, transferData])
              let badGasAndTransferData = ethers.utils.defaultAbiCoder.encode([GasReceiptType, 'bytes'], [badGasReceipt, transferData])
  
              // Encode normally the whole thing
              sigData = ethers.utils.solidityPack(['bytes', 'bytes'], [sigData, goodGasAndTransferData])
            
              // Get signature
              let sig = (await ethSign(transferObj.signerWallet, sigData)).slice(0, -2)
              let paddedNonce = ethers.utils.solidityPack(['uint256'], [transferObj.nonce])
              let ethsig_nonce = sig + paddedNonce.slice(2) + '02' // encode packed the nonce
            
              // PASS BAD DATA
              data = ethers.utils.defaultAbiCoder.encode(txDataTypes, [ethsig_nonce, badGasAndTransferData])
  
              const tx = operatorERC1155Contract.functions.metaSafeTransferFrom(ownerAddress, receiverAddress, id, amount, isGasReceipt, data)
              await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_SIGNATURE") )
            })

            it("should PASS if another approved ERC-1155 is used for fee", async () => {
              let erc1155Contract2 = await erc1155Abstract.deploy(ownerWallet) as ERC1155MetaMintBurnMock
              await erc1155Contract2.functions.mintMock(ownerAddress, feeTokenID, feeTokenInitBalance, [])
              await erc1155Contract2.functions.setApprovalForAll(operatorERC1155Contract.address, true)
    
              feeTokenDataERC1155 = ethers.utils.defaultAbiCoder.encode(
                ['address', 'uint256', 'uint8'], 
                [erc1155Contract2.address, feeTokenID, 0]
              )
    
              gasReceipt = {gasLimitCallback: 130000, gasFee: 1000, 
                feeRecipient: operatorAddress, feeTokenData: feeTokenDataERC1155
              }
    
              // Check if gas receipt is included
              gasReceipt = isGasReceipt ? gasReceipt : null
    
              // Data to pass in transfer method
              data = await encodeMetaTransferFromData(transferObj, domainHash, gasReceipt)
    
              const tx = operatorERC1155Contract.functions.metaSafeTransferFrom(ownerAddress, receiverAddress, id, amount, isGasReceipt, data, 
                {gasLimit: 2000000}
              )
              await expect(tx).to.be.fulfilled
            })

            it("should REVERT if NOT approved ERC-1155 is used for fee", async () => {
              let erc1155Contract2 = await erc1155Abstract.deploy(ownerWallet) as ERC1155MetaMintBurnMock
              await erc1155Contract2.functions.mintMock(ownerAddress, feeTokenID, feeTokenInitBalance, [])
    
              feeTokenDataERC1155 = ethers.utils.defaultAbiCoder.encode(
                ['address', 'uint256', 'uint8'], 
                [erc1155Contract2.address, feeTokenID, 0]
              )
    
              gasReceipt = {gasLimitCallback: 130000, gasFee: 1000,
                feeRecipient: operatorAddress, feeTokenData: feeTokenDataERC1155
              }
    
              // Check if gas receipt is included
              gasReceipt = isGasReceipt ? gasReceipt : null
    
              // Data to pass in transfer method
              data = await encodeMetaTransferFromData(transferObj, domainHash, gasReceipt)
    
              const tx = operatorERC1155Contract.functions.metaSafeTransferFrom(ownerAddress, receiverAddress, id, amount, isGasReceipt, data, 
                {gasLimit: 2000000}
              )
              await expect(tx).to.be.rejectedWith(RevertError('ERC1155#safeTransferFrom: INVALID_OPERATOR'))
            })

            it("should REVERT if another ERC-1155 is used for fee without sufficient balance", async () => {
              let erc1155Contract2 = await erc1155Abstract.deploy(ownerWallet) as ERC1155MetaMintBurnMock
              await erc1155Contract2.functions.mintMock(ownerAddress, feeTokenID, 100, [])
              await erc1155Contract2.functions.setApprovalForAll(operatorERC1155Contract.address, true)
    
              feeTokenDataERC1155 = ethers.utils.defaultAbiCoder.encode(
                ['address', 'uint256', 'uint8'], 
                [erc1155Contract2.address, feeTokenID, 0]
              )
    
              gasReceipt = {gasLimitCallback: 130000, gasFee: 1000,
                feeRecipient: operatorAddress, feeTokenData: feeTokenDataERC1155
              }
    
              // Check if gas receipt is included
              gasReceipt = isGasReceipt ? gasReceipt : null
    
              // Data to pass in transfer method
              data = await encodeMetaTransferFromData(transferObj, domainHash, gasReceipt)
    
              const tx = operatorERC1155Contract.functions.metaSafeTransferFrom(ownerAddress, receiverAddress, id, amount, isGasReceipt, data, 
                {gasLimit: 2000000}
              )
              await expect(tx).to.be.rejectedWith(RevertError('SafeMath#sub: UNDERFLOW'))
            })

            it("should PASS if approved ERC20 is used for fee", async () => {
              let erc20Abstract = await AbstractContract.fromArtifactName('ERC20Mock')
              let erc20Contract = await erc20Abstract.deploy(ownerWallet) as ERC20Mock
              await erc20Contract.functions.mockMint(ownerAddress, feeTokenInitBalance)
              await erc20Contract.functions.approve(operatorERC1155Contract.address, feeTokenInitBalance)
    
              let feeTokenDataERC20 = ethers.utils.defaultAbiCoder.encode(
                ['address', 'uint8'], [erc20Contract.address, 1]
              )
    
              gasReceipt = {gasLimitCallback: 130000, gasFee: 1000,
                feeRecipient: operatorAddress, feeTokenData: feeTokenDataERC20
              }
    
              // Check if gas receipt is included
              gasReceipt = isGasReceipt ? gasReceipt : null
    
              // Data to pass in transfer method
              data = await encodeMetaTransferFromData(transferObj, domainHash, gasReceipt)
    
              const tx = operatorERC1155Contract.functions.metaSafeTransferFrom(ownerAddress, receiverAddress, id, amount, isGasReceipt, data, 
                {gasLimit: 2000000}
              )
              await expect(tx).to.be.fulfilled
            })

            it("should REVERT if NOT approved ERC20 is used for fee", async () => {
              let erc20Abstract = await AbstractContract.fromArtifactName('ERC20Mock')
              let erc20Contract = await erc20Abstract.deploy(ownerWallet) as ERC20Mock
              await erc20Contract.functions.mockMint(ownerAddress, feeTokenInitBalance)
    
              let feeTokenDataERC20 = ethers.utils.defaultAbiCoder.encode(
                ['address', 'uint8'], [erc20Contract.address, 1]
              )
    
              gasReceipt = {gasLimitCallback: 130000, gasFee: 1000,
                feeRecipient: operatorAddress, feeTokenData: feeTokenDataERC20
              }
    
              // Check if gas receipt is included
              gasReceipt = isGasReceipt ? gasReceipt : null
    
              // Data to pass in transfer method
              data = await encodeMetaTransferFromData(transferObj, domainHash, gasReceipt)
    
              const tx = operatorERC1155Contract.functions.metaSafeTransferFrom(ownerAddress, receiverAddress, id, amount, isGasReceipt, data, 
                {gasLimit: 2000000}
              )
              await expect(tx).to.be.rejectedWith(RevertError("SafeMath#sub: UNDERFLOW"))
            })

            it("should REVERT if approved ERC20 balance is insufficient", async () => {
              let erc20Abstract = await AbstractContract.fromArtifactName('ERC20Mock')
              let erc20Contract = await erc20Abstract.deploy(ownerWallet) as ERC20Mock
              await erc20Contract.functions.mockMint(ownerAddress, 100)
              await erc20Contract.functions.approve(operatorERC1155Contract.address, feeTokenInitBalance)

    
              let feeTokenDataERC20 = ethers.utils.defaultAbiCoder.encode(
                ['address', 'uint8'], [erc20Contract.address, 1]
              )
    
              gasReceipt = {gasLimitCallback: 130000, gasFee: 1000,
                feeRecipient: operatorAddress, feeTokenData: feeTokenDataERC20
              }
    
              // Check if gas receipt is included
              gasReceipt = isGasReceipt ? gasReceipt : null
    
              // Data to pass in transfer method
              data = await encodeMetaTransferFromData(transferObj, domainHash, gasReceipt)
    
              const tx = operatorERC1155Contract.functions.metaSafeTransferFrom(ownerAddress, receiverAddress, id, amount, isGasReceipt, data, 
                {gasLimit: 2000000}
              )
              await expect(tx).to.be.rejectedWith(RevertError("SafeMath#sub: UNDERFLOW"))
            })

            it("should REVERT if FeeTokenType is not supported", async () => {
              let erc20Abstract = await AbstractContract.fromArtifactName('ERC20Mock')
              let erc20Contract = await erc20Abstract.deploy(ownerWallet) as ERC20Mock
              await erc20Contract.functions.mockMint(ownerAddress, feeTokenInitBalance)
              await erc20Contract.functions.approve(operatorERC1155Contract.address, feeTokenInitBalance)
    
              let feeTokenDataERC20 = ethers.utils.defaultAbiCoder.encode(
                ['address', 'uint8'], [erc20Contract.address, 2]
              )
    
              gasReceipt = {gasLimitCallback: 130000, gasFee: 1000,
                feeRecipient: operatorAddress, feeTokenData: feeTokenDataERC20
              }
    
              // Check if gas receipt is included
              gasReceipt = isGasReceipt ? gasReceipt : null
    
              // Data to pass in transfer method
              data = await encodeMetaTransferFromData(transferObj, domainHash, gasReceipt)
    
              const tx = operatorERC1155Contract.functions.metaSafeTransferFrom(ownerAddress, receiverAddress, id, amount, isGasReceipt, data, 
                {gasLimit: 2000000}
              )
              await expect(tx).to.be.rejectedWith(RevertError("ERC1155Meta#_transferGasFee: UNSUPPORTED_TOKEN"));

              feeTokenDataERC20 = ethers.utils.defaultAbiCoder.encode(
                ['address', 'uint8'], [erc20Contract.address, 3]
              )
    
              gasReceipt = {gasLimitCallback: 130000, gasFee: 1000,
                feeRecipient: operatorAddress, feeTokenData: feeTokenDataERC20
              }
    
              // Check if gas receipt is included
              gasReceipt = isGasReceipt ? gasReceipt : null
    
              // Data to pass in transfer method
              data = await encodeMetaTransferFromData(transferObj, domainHash, gasReceipt)
    
              const tx2 = operatorERC1155Contract.functions.metaSafeTransferFrom(ownerAddress, receiverAddress, id, amount, isGasReceipt, data, 
                {gasLimit: 2000000}
              )
              await expect(tx2).to.be.rejectedWith(RevertError("ERC1155Meta#_transferGasFee: UNSUPPORTED_TOKEN"));
            })

            it("should REVERT if gas receipt is passed, but not claimed", async () => {
              let tx = operatorERC1155Contract.functions.metaSafeTransferFrom(ownerAddress, receiverAddress, id, amount, false, data)
              await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_SIGNATURE") )
            })
  
            it("should REVERT if gas receipt is passed but isGasFee is false", async () => {
              transferObj.isGasFee = false
              data = await encodeMetaTransferFromData(transferObj, domainHash, gasReceipt)
              let tx = operatorERC1155Contract.functions.metaSafeTransferFrom(ownerAddress, receiverAddress, id, amount, true, data)
              await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_SIGNATURE") )
            })
    
            it("should PASS if gas receipt is passed with isGasFee to false and not claimed", async () => {
              transferObj.isGasFee = false
              data = await encodeMetaTransferFromData(transferObj, domainHash, gasReceipt)
              let tx = operatorERC1155Contract.functions.metaSafeTransferFrom(ownerAddress, receiverAddress, id, amount, false, data)
              await expect(tx).to.be.fulfilled
            })

            describe('When receiver is a contract', () => {

              it('should REVERT if gas used in onERC1155Received exceeds limit', async () => {
                let lowGasLimit = 1000;
                gasReceipt!.gasLimitCallback = lowGasLimit
                transferObj.receiver = receiverContract.address;
  
                data = await encodeMetaTransferFromData(transferObj, domainHash, gasReceipt)
  
                let tx = operatorERC1155Contract.functions.metaSafeTransferFrom(ownerAddress, receiverContract.address, id, amount, isGasReceipt, data, 
                  {gasLimit: 2000000}
                )
                await expect(tx).to.be.rejectedWith(RevertError())
              })

              it('should PASS if gas used in onERC1155Received does not exceed limit', async () => {
                let okGasLimit = 9000;
                gasReceipt!.gasLimitCallback = okGasLimit
                transferObj.receiver = receiverContract.address;
  
                data = await encodeMetaTransferFromData(transferObj, domainHash, gasReceipt)
  
                let tx =  operatorERC1155Contract.functions.metaSafeTransferFrom(ownerAddress, receiverContract.address, id, amount, isGasReceipt, data,
                  {gasLimit: 2000000}
                )
                await expect(tx).to.be.fulfilled
              })

              it('should PASS if gasLimitCallback is higher than gas sent in transaction', async () => {
                let highGasLimit = 30000000;
                gasReceipt!.gasLimitCallback = highGasLimit
                transferObj.receiver = receiverContract.address;
  
                data = await encodeMetaTransferFromData(transferObj, domainHash, gasReceipt)
  
                let tx =  operatorERC1155Contract.functions.metaSafeTransferFrom(ownerAddress, receiverContract.address, id, amount, isGasReceipt, data,
                  {gasLimit: 2000000}
                )
                await expect(tx).to.be.fulfilled
              })
            })
          })

          describe('When gas is NOT reimbursed', () => {
            before(async function () {
              if (condition[1]){
                this.test!.parent!.pending = true;
                this.skip();
              }
            });

            it("should PASS if gas receipt is not passed and not claimed", async () => {
              let tx = operatorERC1155Contract.functions.metaSafeTransferFrom(ownerAddress, receiverAddress, id, amount, false, data)
              await expect(tx).to.be.fulfilled;
            })
    
            it("should REVER if gas receipt is not passed and claimed", async () => {
              let tx = operatorERC1155Contract.functions.metaSafeTransferFrom(ownerAddress, receiverAddress, id, amount, true, data)
              await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_SIGNATURE") )
            })
    
            it("should REVERT if gas receipt is not passed but isGasFee is set to true and is claimed", async () => {
              transferObj.isGasFee = true
              data = await encodeMetaTransferFromData(transferObj, domainHash, gasReceipt)
              let tx = operatorERC1155Contract.functions.metaSafeTransferFrom(ownerAddress, receiverAddress, id, amount, true, data)
              await expect(tx).to.be.rejectedWith(RevertError());
            })
          })

          context('When successful transfer', () => {
            let tx: ethers.ContractTransaction

            beforeEach(async () => {
              tx = await operatorERC1155Contract.functions.metaSafeTransferFrom(ownerAddress, receiverAddress, id, amount, isGasReceipt, data)
            })

            it('should correctly update balance of sender', async () => {
              const balance = await erc1155Contract.functions.balanceOf(ownerAddress, id)
              expect(balance).to.be.eql(new BigNumber(initBalance - amount))
            })

            it('should correctly update balance of receiver', async () => {
              const balance = await erc1155Contract.functions.balanceOf(receiverAddress, id)
              expect(balance).to.be.eql(new BigNumber(amount))
            })

            describe('When gas is reimbursed', () => {
              before(async function () {
                if (!condition[1]){
                  this.test!.parent!.pending = true;
                  this.skip();
                }
              });

              it('should update gas token balance of sender', async () => {
                const senderBalance = await erc1155Contract.functions.balanceOf(ownerAddress, feeTokenID)
                expect(senderBalance).to.be.eql(feeTokenInitBalance.sub(gasReceipt!.gasFee))
              })

              it('should update gas token balance of executor', async () => {
                const balance = await erc1155Contract.functions.balanceOf(operatorAddress, feeTokenID)
                expect(gasReceipt!.gasFee).to.be.eql(balance.toNumber());
              })
            })

            describe('TransferSingle event', async () => {

              let filterFromOperatorContract: ethers.ethers.EventFilter

              it('should emit TransferSingle event', async () => {
                const receipt = await tx.wait(1)
                const ev = receipt.events!.pop()!
                expect(ev.event).to.be.eql('TransferSingle')
              })

              it('should have `msg.sender` as `_operator` field, not _from', async () => {
                const receipt = await tx.wait(1)
                const ev = receipt.events!.pop()!

                const args = ev.args! as any
                expect(args._operator).to.be.eql(operatorAddress)
              })

              it('should have `msg.sender` as `_operator` field, not tx.origin', async () => {

                // Get event filter to get internal tx event
                filterFromOperatorContract = erc1155Contract.filters.TransferSingle(operatorContract.address, null, null, null, null);

                // Increment nonce because it's the second transfer
                transferObj.nonce = nonce.add(1);
                data = await encodeMetaTransferFromData(transferObj, domainHash, gasReceipt)

                // Execute transfer from operator contract
                // @ts-ignore (https://github.com/ethereum-ts/TypeChain/issues/118)
                await operatorContract.functions.metaSafeTransferFrom(erc1155Contract.address, ownerAddress, receiverAddress, id, amount, isGasReceipt, data, 
                  {gasLimit: 1000000} // INCORRECT GAS ESTIMATION
                )

                // Get logs from internal transaction event
                // @ts-ignore (https://github.com/ethers-io/ethers.js/issues/204#issuecomment-427059031)
                filterFromOperatorContract.fromBlock = 0;
                let logs = await operatorProvider.getLogs(filterFromOperatorContract);
                let args = erc1155Contract.interface.events.TransferSingle.decode(logs[0].data, logs[0].topics)

                // operator arg should be equal to msg.sender, not tx.origin
                expect(args._operator).to.be.eql(operatorContract.address)
              })

              it('should emit NonceChange event', async () => {
                const receipt = await tx.wait(1)
                const ev = receipt.events![0]
                expect(ev.event).to.be.eql('NonceChange')
              })

              it('should have `_signer` as `signer` in NonceChange', async () => {
                const receipt = await tx.wait(1)
                const ev = receipt.events![0]

                const args = ev.args! as any
                expect(args.signer).to.be.eql(ownerWallet.address)
              })

              it('should have `nonce` as `nonce + 1` in NonceChange', async () => {
                const receipt = await tx.wait(1)
                const ev = receipt.events![0]

                const args = ev.args! as any
                expect(args.newNonce).to.be.eql(nonce.add(1))
              })
            })
          })
        })
      })
    })
  })





  describe('metaSafeBatchTransferFrom() Function', () => {
    let receiverContract: ERC1155ReceiverMock
    let operatorContract: ERC1155OperatorMock
    let METATRANSFER_IDENTIFIER = '0xebc71fa5';
    
    let transferData: string | null = 'Hello from the other side'
    let initBalance = 100;
    let amount = 10;
    let nonce = new BigNumber(0);

    // Parameters for balances
    let ids: any[], amounts: any[]
    let nTokenTypes = 33
    
    let isGasReceipt: boolean = true;
    let feeTokenInitBalance = new BigNumber(100000000);

    let feeType = 0
    let feeTokenID = 666
    let feeTokenAddress: string;
    let feeTokenDataERC1155: string | Uint8Array

    let transferObj: BatchTransferSignature;
    let gasReceipt: GasReceipt | null;
    let domainHash: string;
    let data: string;

    let conditions = [
      [transferData, true, 'Gas receipt & transfer data'],
      [null, true, 'Gas receipt w/o transfer data'], 
      [transferData, false, 'Transfer data w/o gas receipt '],  
      [null, false, 'No Gas receipt & No transfer data']  
    ]

    conditions.forEach(function(condition) {
      context(condition[2] as string, () => {

        beforeEach(async () => {

          // Get conditions
          transferData = await condition[0] as string | null
          isGasReceipt = await condition[1] as boolean

          // Deploy contracts
          let abstract = await AbstractContract.fromArtifactName('ERC1155ReceiverMock')
          receiverContract = await abstract.deploy(ownerWallet) as ERC1155ReceiverMock
          operatorContract = await operatorAbstract.deploy(operatorWallet) as ERC1155OperatorMock

          // Mint tokens
          ids = [], amounts = []

          // Minting enough amounts for transfer for each types
          for (let i = 0; i < nTokenTypes; i++) {
            await erc1155Contract.functions.mintMock(ownerAddress, i, initBalance, [])
            ids.push(i)
            amounts.push(amount)
          }

          feeTokenAddress = erc1155Contract.address

          feeTokenDataERC1155 = ethers.utils.defaultAbiCoder.encode(
            ['address', 'uint256', 'uint8'], 
            [feeTokenAddress,  feeTokenID, feeType]
          )

          // Gas Receipt
          gasReceipt = {
            gasLimitCallback: 130000,
            gasFee: 30000,
            feeRecipient: operatorAddress,
            feeTokenData: feeTokenDataERC1155,
          }

          // Check if gas receipt is included
          gasReceipt = isGasReceipt ? gasReceipt : null
          
          // Transfer Signature Object
          transferObj = {
            contractAddress: erc1155Contract.address,
            signerWallet: ownerWallet,
            receiver: receiverAddress,
            ids: ids.slice(0),
            amounts: amounts.slice(0),
            isGasFee: isGasReceipt,
            transferData: transferData === null ? null : toUtf8Bytes(transferData),
            nonce: nonce
          }

          // Mint tokens used to pay for gas
          await erc1155Contract.functions.mintMock(ownerAddress, feeTokenID, feeTokenInitBalance, [])

          // Domain hash
          domainHash = ethers.utils.keccak256(ethers.utils.solidityPack(
            ['bytes32', 'uint256'], 
            [DOMAIN_SEPARATOR_TYPEHASH, erc1155Contract.address]
          ))

          // Data to pass in transfer method
          data = await encodeMetaBatchTransferFromData(transferObj, domainHash, gasReceipt)
        })

        it("should REVERT if contract address is incorrect", async () => {
          domainHash = ethers.utils.keccak256(ethers.utils.solidityPack(
            ['bytes32', 'uint256'], 
            [DOMAIN_SEPARATOR_TYPEHASH, receiverContract.address]
          ))
          data = await encodeMetaBatchTransferFromData(transferObj, domainHash, gasReceipt)

          const tx = operatorERC1155Contract.functions.metaSafeBatchTransferFrom(ownerAddress, receiverAddress, ids, amounts, isGasReceipt, data)
          await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_SIGNATURE") )    
        })

        it("should REVERT if signer address is incorrect", async () => {
          transferObj.signerWallet = operatorWallet;
          data = await encodeMetaBatchTransferFromData(transferObj, domainHash, gasReceipt)

          const tx = operatorERC1155Contract.functions.metaSafeBatchTransferFrom(ownerAddress, receiverAddress, ids, amounts, isGasReceipt, data)
          await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_SIGNATURE") )  
        })

        it("should REVERT if receiver address is incorrect", async () => {
          transferObj.receiver = ownerAddress;
          data = await encodeMetaBatchTransferFromData(transferObj, domainHash, gasReceipt)

          const tx = operatorERC1155Contract.functions.metaSafeBatchTransferFrom(ownerAddress, receiverAddress, ids, amounts, isGasReceipt, data)
          await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_SIGNATURE") )  
        })

        it("should REVERT if token id is incorrect", async () => {
          transferObj.ids[0] = 6;
          data = await encodeMetaBatchTransferFromData(transferObj, domainHash, gasReceipt)

          const tx = operatorERC1155Contract.functions.metaSafeBatchTransferFrom(ownerAddress, receiverAddress, ids, amounts, isGasReceipt, data)
          await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_SIGNATURE") )  
        })

        it("should REVERT if token amount is incorrect", async () => {
          transferObj.amounts[0] = amount + 1;
          data = await encodeMetaBatchTransferFromData(transferObj, domainHash, gasReceipt)

          const tx = operatorERC1155Contract.functions.metaSafeBatchTransferFrom(ownerAddress, receiverAddress, ids, amounts, isGasReceipt, data)
          await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_SIGNATURE") )  
        })

        it("should REVERT if transfer data is incorrect", async () => {
          const sigArgTypes = ['address', 'address', 'address', 'uint256[]', 'uint256[]', 'uint256'];
          const txDataTypes = ['bytes', 'bytes'];
        
          let signer = await transferObj.signerWallet.getAddress()
          
          // Packed encoding of transfer signature message
          let sigData = ethers.utils.solidityPack(sigArgTypes, [
            transferObj.contractAddress, signer, transferObj.receiver, transferObj.ids, 
            transferObj.amounts, transferObj.nonce
          ])

          let transferData = transferObj.transferData == null ? toUtf8Bytes('') : transferObj.transferData
          let goodGasAndTransferData;
          let badGasAndTransferData;

          // Correct and incorrect transferData
          if (isGasReceipt) {
            goodGasAndTransferData = ethers.utils.defaultAbiCoder.encode([GasReceiptType, 'bytes'], [gasReceipt, transferData])
            badGasAndTransferData = ethers.utils.defaultAbiCoder.encode([GasReceiptType, 'bytes'], [gasReceipt, toUtf8Bytes('Goodbyebyebye')])
          } else {
            goodGasAndTransferData = ethers.utils.defaultAbiCoder.encode(['bytes'], [transferData])
            badGasAndTransferData = ethers.utils.defaultAbiCoder.encode(['bytes'], [toUtf8Bytes('Goodbyebyebye')])
          }

          // Encode normally the whole thing
          sigData = ethers.utils.solidityPack(['bytes', 'bytes'], [sigData, goodGasAndTransferData])
        
          // Get signature
          let sig = (await ethSign(transferObj.signerWallet, sigData)).slice(0, -2)
          let paddedNonce = ethers.utils.solidityPack(['uint256'], [transferObj.nonce])
          let ethsig_nonce = sig + paddedNonce.slice(2) + '02' // encode packed the nonce
        
          // PASS BAD DATA
          data = ethers.utils.defaultAbiCoder.encode(txDataTypes, [ethsig_nonce, badGasAndTransferData])

          const tx = operatorERC1155Contract.functions.metaSafeBatchTransferFrom(ownerAddress, receiverAddress, ids, amounts, isGasReceipt, data)
          await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_SIGNATURE") )
        })

        it("should REVERT if nonce is incorrect", async () => {
          transferObj.nonce = nonce.add(101);
          data = await encodeMetaBatchTransferFromData(transferObj, domainHash, gasReceipt)

          const tx = operatorERC1155Contract.functions.metaSafeBatchTransferFrom(ownerAddress, receiverAddress, ids, amounts, isGasReceipt, data)
          await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_NONCE") ) 

          // Correct nonce
          transferObj.nonce = nonce
          data = await encodeMetaBatchTransferFromData(transferObj, domainHash, gasReceipt)
          await operatorERC1155Contract.functions.metaSafeBatchTransferFrom(ownerAddress, receiverAddress, ids, amounts, isGasReceipt, data)
          
          // Nonce lower
          const tx2 = operatorERC1155Contract.functions.metaSafeBatchTransferFrom(ownerAddress, receiverAddress, ids, amounts, isGasReceipt, data)
          await expect(tx2).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_NONCE") ) 
        })

        it("should PASS if signature is valid", async () => {
          const tx = operatorERC1155Contract.functions.metaSafeBatchTransferFrom(ownerAddress, receiverAddress, ids, amounts, isGasReceipt, data)
          await expect(tx).to.be.fulfilled
        })

        describe('ERC-1271 Receiver', () => {
          let erc1271WalletValidationMockContract: ERC1271WalletValidationMock
          let ERC1271WalletValidationMockAbstract: AbstractContract

          let erc1271WalletAddress;

          beforeEach( async () => {
            ERC1271WalletValidationMockAbstract = await AbstractContract.fromArtifactName('ERC1271WalletValidationMock')
            erc1271WalletValidationMockContract = await ERC1271WalletValidationMockAbstract.deploy(ownerWallet, [domainHash]) as ERC1271WalletValidationMock
            erc1271WalletAddress = erc1271WalletValidationMockContract.address;

            await erc1155Contract.functions.batchMintMock(erc1271WalletAddress, ids, amounts, [])
            await erc1155Contract.functions.mintMock(erc1271WalletAddress, feeTokenID, feeTokenInitBalance, [])        
          })

          describe(`EIP-1271 (bytes) signatures (03)`, () => {
            it('should return REVERT if signature is invalid', async () => {
              transferObj.from = erc1271WalletAddress;
              transferObj.signerWallet = receiverWallet;

              data = await encodeMetaBatchTransferFromData(transferObj, domainHash, gasReceipt, '03')
              const tx = operatorERC1155Contract.functions.metaSafeBatchTransferFrom(erc1271WalletAddress, receiverAddress, ids, amounts, isGasReceipt, data)
              await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_SIGNATURE") )
            })
          })

          describe(`EIP-1271 (bytes32) signatures (04)`, () => {
            it('should return REVERT if signature is invalid', async () => {
              transferObj.from = erc1271WalletAddress;
              transferObj.signerWallet = receiverWallet;

              data = await encodeMetaBatchTransferFromData(transferObj, domainHash, gasReceipt, '04')
              const tx = operatorERC1155Contract.functions.metaSafeBatchTransferFrom(erc1271WalletAddress, receiverAddress, ids, amounts, isGasReceipt, data)
              await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_SIGNATURE") )
            })
    
            it('should PASS if signature is valid', async () => {
              transferObj.from = erc1271WalletAddress;
              data = await encodeMetaBatchTransferFromData(transferObj, domainHash, gasReceipt, '04')
              const tx = operatorERC1155Contract.functions.metaSafeBatchTransferFrom(erc1271WalletAddress, receiverAddress, ids, amounts, isGasReceipt, data)
              await expect(tx).to.be.fulfilled  
            })
          })
        })


        describe('When signature is valid', () => {

          it('should REVERT if insufficient balance', async () => {
            transferObj.amounts[0] = initBalance+1;
            amounts[0] = initBalance+1;
            data = await encodeMetaBatchTransferFromData(transferObj, domainHash, gasReceipt)

            const tx = operatorERC1155Contract.functions.metaSafeBatchTransferFrom(ownerAddress, receiverAddress, ids, amounts, isGasReceipt, data)
            await expect(tx).to.be.rejectedWith( RevertError("SafeMath#sub: UNDERFLOW") ) 
          })

          it('should REVERT if sending to 0x0', async () => {
            transferObj.receiver = ZERO_ADDRESS;
            data = await encodeMetaBatchTransferFromData(transferObj, domainHash, gasReceipt)

            const tx = operatorERC1155Contract.functions.metaSafeBatchTransferFrom(ownerAddress, ZERO_ADDRESS, ids, amounts, isGasReceipt, data)
            await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#metaSafeBatchTransferFrom: INVALID_RECIPIENT") ) 
          })

          it('should REVERT if transfer leads to overflow', async () => {
            await operatorERC1155Contract.functions.mintMock(receiverAddress, ids[0], MAXVAL, [])
            const tx = operatorERC1155Contract.functions.metaSafeBatchTransferFrom(ownerAddress, receiverAddress, ids, amounts, isGasReceipt, data)
            await expect(tx).to.be.rejectedWith( RevertError("SafeMath#add: OVERFLOW") ) 
          })

          it('should REVERT when sending to non-receiver contract', async () => {
            transferObj.receiver = erc1155Contract.address;
            data = await encodeMetaBatchTransferFromData(transferObj, domainHash, gasReceipt)

            const tx = operatorERC1155Contract.functions.metaSafeBatchTransferFrom(ownerAddress, erc1155Contract.address, ids, amounts, isGasReceipt, data)
            await expect(tx).to.be.rejectedWith(RevertError("ERC1155MetaMintBurnMock: INVALID_METHOD"));
          })

          it('should REVERT if invalid response from receiver contract', async () => {
            transferObj.receiver = receiverContract.address;
            data = await encodeMetaBatchTransferFromData(transferObj, domainHash, gasReceipt)

            // Force invalid response
            await receiverContract.functions.setShouldReject(true)

            const tx = operatorERC1155Contract.functions.metaSafeBatchTransferFrom(ownerAddress, receiverContract.address, ids, amounts, isGasReceipt, data)
            await expect(tx).to.be.rejectedWith( RevertError("ERC1155#_callonERC1155BatchReceived: INVALID_ON_RECEIVE_MESSAGE") )

          })

          it('should PASS if valid response from receiver contract', async () => {
            transferObj.receiver = receiverContract.address;
            data = await encodeMetaBatchTransferFromData(transferObj, domainHash, gasReceipt)

            const tx = operatorERC1155Contract.functions.metaSafeBatchTransferFrom(ownerAddress, receiverContract.address, ids, amounts, isGasReceipt, data,
              {gasLimit: 2000000}
            )

            //await expect(tx).to.be.fulfilled
            await expect(tx).to.be.fulfilled
          })

          describe('When gas is reimbursed', () => {
            before(async function () {
              if (!condition[1]){
                this.test!.parent!.pending = true;
                this.skip();
              }
            });

            it('should send gas fee to tx.origin is fee recipient ix 0x0', async () => {
              gasReceipt!.feeRecipient = ZERO_ADDRESS;

              data = await encodeMetaBatchTransferFromData(transferObj, domainHash, gasReceipt)

              await receiverERC1155Contract.functions.metaSafeBatchTransferFrom(ownerAddress, receiverAddress, ids, amounts, isGasReceipt, data)

              let receiverBalance = await operatorERC1155Contract.functions.balanceOf(receiverAddress, feeTokenID)

              expect(gasReceipt!.gasFee).to.be.eql(receiverBalance.toNumber())
            })

            it("should send gas fee to specified fee recipient (if not 0x0), not tx.origin", async () => {
              await receiverERC1155Contract.functions.metaSafeBatchTransferFrom(ownerAddress, receiverAddress, ids, amounts, isGasReceipt, data)
              let operatorBalance = await operatorERC1155Contract.functions.balanceOf(operatorAddress, feeTokenID)

              expect(gasReceipt!.gasFee).to.be.eql(operatorBalance.toNumber())
            })

            it("should REVERT if gasReceipt is incorrect", async () => {
              const sigArgTypes = ['address', 'address', 'address', 'uint256[]', 'uint256[]', 'uint256'];
              const txDataTypes = ['bytes', 'bytes'];
            
              let signer = await transferObj.signerWallet.getAddress()
              
              // Packed encoding of transfer signature message
              let sigData = ethers.utils.solidityPack(sigArgTypes, [
                transferObj.contractAddress, signer, transferObj.receiver, transferObj.ids, 
                transferObj.amounts, transferObj.nonce
              ])
  
              // Form bad gas receipt
              let badGasReceipt = {...gasReceipt, gasPrice: 109284123}
  
              let transferData = transferObj.transferData == null ? toUtf8Bytes('') : transferObj.transferData
  
              // Correct and incorrect transferData
              let goodGasAndTransferData = ethers.utils.defaultAbiCoder.encode([GasReceiptType, 'bytes'], [gasReceipt, transferData])
              let badGasAndTransferData = ethers.utils.defaultAbiCoder.encode([GasReceiptType, 'bytes'], [badGasReceipt, transferData])
  
              // Encode normally the whole thing
              sigData = ethers.utils.solidityPack(['bytes', 'bytes'], [sigData, goodGasAndTransferData])
            
              // Get signature
              let sig = (await ethSign(transferObj.signerWallet, sigData)).slice(0, -2)
              let paddedNonce = ethers.utils.solidityPack(['uint256'], [transferObj.nonce])
              let ethsig_nonce = sig + paddedNonce.slice(2) + '02' // encode packed the nonce
            
              // PASS BAD DATA
              data = ethers.utils.defaultAbiCoder.encode(txDataTypes, [ethsig_nonce, badGasAndTransferData])
  
              const tx = operatorERC1155Contract.functions.metaSafeBatchTransferFrom(ownerAddress, receiverAddress, ids, amounts, isGasReceipt, data)
              await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_SIGNATURE") )
            })

            it("should REVERT if gas receipt is passed, but not claimed", async () => {
              let tx = operatorERC1155Contract.functions.metaSafeBatchTransferFrom(ownerAddress, receiverAddress, ids, amounts, false, data)
              await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_SIGNATURE") )
            })
  
            it("should REVERT if gas receipt is passed but isGasFee is false", async () => {
              transferObj.isGasFee = false
              data = await encodeMetaBatchTransferFromData(transferObj, domainHash, gasReceipt)
              let tx = operatorERC1155Contract.functions.metaSafeBatchTransferFrom(ownerAddress, receiverAddress, ids, amounts, true, data)
              await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_SIGNATURE") )
            })
    
            it("should PASS if gas receipt is passed with isGasFee to false and not claimed", async () => {
              transferObj.isGasFee = false
              data = await encodeMetaBatchTransferFromData(transferObj, domainHash, gasReceipt)
    
              let tx = operatorERC1155Contract.functions.metaSafeBatchTransferFrom(ownerAddress, receiverAddress, ids, amounts, false, data)
              await expect(tx).to.be.fulfilled
            })

            describe('When receiver is a contract', () => {

              it('should REVERT if gas used in onERC1155BatchReceived exceeds limit', async () => {
                let lowGasLimit = 1000;
                gasReceipt!.gasLimitCallback = lowGasLimit
                transferObj.receiver = receiverContract.address;
  
                data = await encodeMetaBatchTransferFromData(transferObj, domainHash, gasReceipt)
  
                let tx = operatorERC1155Contract.functions.metaSafeBatchTransferFrom(ownerAddress, receiverContract.address, ids, amounts, isGasReceipt, data, 
                  {gasLimit: 2000000}
                )
                await expect(tx).to.be.rejectedWith(RevertError())
              })

              it('should PASS if gas used in onERC1155BatchReceived does not exceed limit', async () => {
                let okGasLimit = 120000;
                gasReceipt!.gasLimitCallback = okGasLimit
                transferObj.receiver = receiverContract.address;
  
                data = await encodeMetaBatchTransferFromData(transferObj, domainHash, gasReceipt)
  
                let tx =  operatorERC1155Contract.functions.metaSafeBatchTransferFrom(ownerAddress, receiverContract.address, ids, amounts, isGasReceipt, data,
                  {gasLimit: 2000000}
                )
                await expect(tx).to.be.fulfilled
              })

              it('should PASS if gasLimit is higher than gas sent in transaction', async () => {
                let highGasLimit = 3000000;
                gasReceipt!.gasLimitCallback = highGasLimit
                transferObj.receiver = receiverContract.address;
  
                data = await encodeMetaBatchTransferFromData(transferObj, domainHash, gasReceipt)
  
                let tx =  operatorERC1155Contract.functions.metaSafeBatchTransferFrom(ownerAddress, receiverContract.address, ids, amounts, isGasReceipt, data,
                  {gasLimit: 2000000}
                )
                await expect(tx).to.be.fulfilled
              })
            })
          })

          describe('When gas is NOT reimbursed', () => {
            before(async function () {
              if (condition[1]){
                this.test!.parent!.pending = true;
                this.skip();
              }
            });

            it("should PASS if gas receipt is not passed and not claimed", async () => {
              let tx = operatorERC1155Contract.functions.metaSafeBatchTransferFrom(ownerAddress, receiverAddress, ids, amounts, false, data)
              await expect(tx).to.be.fulfilled;
            })
    
            it("should REVER if gas receipt is not passed and claimed", async () => {
              let tx = operatorERC1155Contract.functions.metaSafeBatchTransferFrom(ownerAddress, receiverAddress, ids, amounts, true, data)
              await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_SIGNATURE") )
            })
    
            it("should REVERT if gas receipt is not passed but isGasFee is set to true and is claimed", async () => {
              transferObj.isGasFee = true
              data = await encodeMetaBatchTransferFromData(transferObj, domainHash)
              let tx = operatorERC1155Contract.functions.metaSafeBatchTransferFrom(ownerAddress, receiverAddress, ids, amounts, true, data)
              await expect(tx).to.be.rejectedWith(RevertError());
            })
          })
 

          context('When successful transfer', () => {
            let tx: ethers.ContractTransaction

            beforeEach(async () => {
              tx = await operatorERC1155Contract.functions.metaSafeBatchTransferFrom(ownerAddress, receiverAddress, ids, amounts, isGasReceipt, data)
            })

            it('should correctly update balance of sender and receiver', async () => {
              let balanceFrom: ethers.utils.BigNumber
              let balanceTo: ethers.utils.BigNumber
        
              for (let i = 0; i < ids.length; i++) {
                balanceFrom = await operatorERC1155Contract.functions.balanceOf(ownerAddress, ids[i])
                balanceTo   = await operatorERC1155Contract.functions.balanceOf(receiverAddress, ids[i])
        
                expect(balanceFrom).to.be.eql(new BigNumber(initBalance - amounts[i]))
                expect(balanceTo).to.be.eql(new BigNumber(amounts[i]))
              }
            })

            describe('When gas is reimbursed', () => {
              before(async function () {
              if (!condition[1]){
                  this.test!.parent!.pending = true;
                  this.skip();
                }
              });

              it('should update gas token balance of sender', async () => {
                const senderBalance = await operatorERC1155Contract.functions.balanceOf(ownerAddress, feeTokenID)
                expect(senderBalance).to.be.eql(feeTokenInitBalance.sub(gasReceipt!.gasFee))
              })

              it('should update gas token balance of executor', async () => {
                const balance = await operatorERC1155Contract.functions.balanceOf(operatorAddress, feeTokenID)
                expect(gasReceipt!.gasFee).to.be.eql(balance.toNumber());
              })
            })

            describe('TransferBatch event', async () => {
              let filterFromOperatorContract: ethers.ethers.EventFilter
              let operatorContract: ERC1155OperatorMock
        
              beforeEach(async () => {
                operatorContract = await operatorAbstract.deploy(operatorWallet) as ERC1155OperatorMock
              })
        
              it('should emit 1 TransferBatch events of N transfers', async () => {
                const receipt = await tx.wait(1)
                const ev = receipt.events![1]
                expect(ev.event).to.be.eql('TransferBatch')
        
                const args = ev.args! as any
                expect(args._ids.length).to.be.eql(ids.length)
              })
        
              it('should have `msg.sender` as `_operator` field, not _from', async () => {                
                const receipt = await tx.wait(1)
                const ev = receipt.events!.pop()!
        
                const args = ev.args! as any
                expect(args._operator).to.be.eql(operatorAddress)
              })
        
              it('should have `msg.sender` as `_operator` field, not tx.origin', async () => {
        
                // Get event filter to get internal tx event
                filterFromOperatorContract = erc1155Contract.filters.TransferBatch(operatorContract.address, null, null, null, null);

                //Increment nonce because it's the second transfer
                transferObj.nonce = nonce.add(1);
                data = await encodeMetaBatchTransferFromData(transferObj, domainHash, gasReceipt)
  
        
                // Execute transfer from operator contract
                // @ts-ignore (https://github.com/ethereum-ts/TypeChain/issues/118)
                await operatorContract.functions.metaSafeBatchTransferFrom(erc1155Contract.address, ownerAddress, receiverAddress, ids, amounts, isGasReceipt, data, 
                  {gasLimit: 2000000} // INCORRECT GAS ESTIMATION
                )
        
                // Get logs from internal transaction event
                // @ts-ignore (https://github.com/ethers-io/ethers.js/issues/204#issuecomment-427059031)
                filterFromOperatorContract.fromBlock = 0;
                let logs = await operatorProvider.getLogs(filterFromOperatorContract);
                let args = erc1155Contract.interface.events.TransferBatch.decode(logs[0].data, logs[0].topics)
        
        
                // operator arg should be equal to msg.sender, not tx.origin
                expect(args._operator).to.be.eql(operatorContract.address)
              })

              it('should emit NonceChange event', async () => {
                const receipt = await tx.wait(1)
                const ev = receipt.events![0]
                expect(ev.event).to.be.eql('NonceChange')
              })

              it('should have `_signer` as `signer` in NonceChange', async () => {
                const receipt = await tx.wait(1)
                const ev = receipt.events![0]

                const args = ev.args! as any
                expect(args.signer).to.be.eql(ownerWallet.address)
              })

              it('should have `nonce` as `nonce + 1` in NonceChange', async () => {
                const receipt = await tx.wait(1)
                const ev = receipt.events![0]

                const args = ev.args! as any
                expect(args.newNonce).to.be.eql(nonce.add(1))
              })

            })
          })
        })
      })
    })
  })







  describe('metaSetApprovalForAll() function', () => {

    let initBalance = 100;
    let isGasReimbursed = true;
    let approved = true;
    let nonce = new BigNumber(0);
    let id = 66;

    let approvalObj: ApprovalSignature;
    let gasReceipt : GasReceipt | null;
    let domainHash : string;
    let data: string;

    let isGasReceipt: boolean = true;
    let feeTokenInitBalance = new BigNumber(100000000);

    let feeType = 0
    let feeTokenID = 666  
    let feeTokenAddress : string
    let feeTokenDataERC1155: string | Uint8Array

    let conditions = [
      [true, 'Gas receipt'],  
      [false, 'No Gas receipt']  
    ]

    conditions.forEach(function(condition) {
      context(condition[1] as string, () => {
        beforeEach(async () => {
          isGasReceipt = condition[0] as boolean

          feeTokenAddress = erc1155Contract.address

          feeTokenDataERC1155 = ethers.utils.defaultAbiCoder.encode(
            ['address', 'uint256', 'uint8'], 
            [feeTokenAddress,  feeTokenID, feeType]
          )

          // Gas Receipt
          gasReceipt = {
            gasLimitCallback: 125000,
            gasFee: 30000,
            feeRecipient: operatorAddress,
            feeTokenData: feeTokenDataERC1155,
          }

          // Check if gas receipt is included
          gasReceipt = isGasReceipt ? gasReceipt : null
          isGasReimbursed = isGasReceipt ? true : false

          // Approval Signture Object
          approvalObj = {
            contractAddress: erc1155Contract.address,
            signerWallet: ownerWallet,
            operator: operatorAddress,
            approved: approved,
            isGasFee: isGasReceipt,
            nonce: nonce
          }

          // Mint tokens
          await erc1155Contract.functions.mintMock(ownerAddress, id, initBalance, [])

          // Mint tokens used to pay for gas
          await erc1155Contract.functions.mintMock(ownerAddress, feeTokenID, feeTokenInitBalance, [])

          // Domain hash
          domainHash = ethers.utils.keccak256(ethers.utils.solidityPack(
            ['bytes32', 'uint256'], 
            [DOMAIN_SEPARATOR_TYPEHASH, erc1155Contract.address]
          ))
          // Data to pass in approval method
          data = await encodeMetaApprovalData(approvalObj, domainHash, gasReceipt)
        })

        it("should PASS if signature is valid", async () => {
          let tx = operatorERC1155Contract.functions.metaSetApprovalForAll(ownerAddress, operatorAddress, approved, isGasReimbursed, data)
          await expect(tx).to.be.fulfilled
        })

        describe('ERC-1271 Receiver', () => {
          let erc1271WalletValidationMockContract: ERC1271WalletValidationMock
          let ERC1271WalletValidationMockAbstract: AbstractContract

          let erc1271WalletAddress;

          beforeEach( async () => {
            ERC1271WalletValidationMockAbstract = await AbstractContract.fromArtifactName('ERC1271WalletValidationMock')
            erc1271WalletValidationMockContract = await ERC1271WalletValidationMockAbstract.deploy(ownerWallet, [domainHash]) as ERC1271WalletValidationMock
            erc1271WalletAddress = erc1271WalletValidationMockContract.address;

            await erc1155Contract.functions.mintMock(erc1271WalletAddress, feeTokenID, feeTokenInitBalance, [])        
          })

          describe(`EIP-1271 (bytes) signatures (03)`, () => {
            it('should return REVERT if signature is invalid', async () => {
              approvalObj.owner = erc1271WalletAddress;
              approvalObj.signerWallet = receiverWallet;

              data = await encodeMetaApprovalData(approvalObj, domainHash, gasReceipt, '03')
              let tx = operatorERC1155Contract.functions.metaSetApprovalForAll(erc1271WalletAddress, operatorAddress, approved, isGasReimbursed, data)
              await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_SIGNATURE") )
            })
          })

          describe(`EIP-1271 (bytes32) signatures (04)`, () => {
            it('should return REVERT if signature is invalid', async () => {
              approvalObj.owner = erc1271WalletAddress;
              approvalObj.signerWallet = receiverWallet;

              data = await encodeMetaApprovalData(approvalObj, domainHash, gasReceipt, '04')
              let tx = operatorERC1155Contract.functions.metaSetApprovalForAll(erc1271WalletAddress, operatorAddress, approved, isGasReimbursed, data)
              await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_SIGNATURE") )
            })
    
            it('should PASS if signature is valid', async () => {
              approvalObj.owner = erc1271WalletAddress;
              data = await encodeMetaApprovalData(approvalObj, domainHash, gasReceipt, '04')
              let tx = operatorERC1155Contract.functions.metaSetApprovalForAll(erc1271WalletAddress, operatorAddress, approved, isGasReimbursed, data)
              await expect(tx).to.be.fulfilled  
            })
          })
        })

        describe('When gas is reimbursed', () => {
          before(async function () {
            if (!condition[0]){
              this.test!.parent!.pending = true;
              this.skip();
            }
          });

          it("should REVERT if gas receipt is passed, but not claimed", async () => {
            let tx = operatorERC1155Contract.functions.metaSetApprovalForAll(ownerAddress, operatorAddress, approved, false, data)
            await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_SIGNATURE") )
          })

          it("should REVERT if gas receipt is passed but isGasFee is false", async () => {
            approvalObj.isGasFee = false
            data = await encodeMetaApprovalData(approvalObj, domainHash, gasReceipt)
            let tx = operatorERC1155Contract.functions.metaSetApprovalForAll(ownerAddress, operatorAddress, approved, true, data)
            await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_SIGNATURE") )
          })
  
          it("should PASS if gas receipt is passed with isGasFee to false and not claimed", async () => {
            approvalObj.isGasFee = false
            data = await encodeMetaApprovalData(approvalObj, domainHash, gasReceipt)
  
            let tx = operatorERC1155Contract.functions.metaSetApprovalForAll(ownerAddress, operatorAddress, approved, false, data)
            await expect(tx).to.be.fulfilled
          })
        })

        describe('When gas is NOT reimbursed', () => {

          before(async function () {
            if (condition[0]){
              this.test!.parent!.pending = true;
              this.skip();
            }
          });

          it("should PASS if gas receipt is not passed and not claimed", async () => {
            let tx = operatorERC1155Contract.functions.metaSetApprovalForAll(ownerAddress, operatorAddress, approved, false, data)
            await expect(tx).to.be.fulfilled;
          })
  
          it("should REVER if gas receipt is not passed and claimed", async () => {
            let tx = operatorERC1155Contract.functions.metaSetApprovalForAll(ownerAddress, operatorAddress, approved, true, data)
            await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_SIGNATURE") )
          })
  
          it("should REVERT if gas receipt is not passed but isGasFee is set to true and is claimed", async () => {
            approvalObj.isGasFee = true
            data = await encodeMetaApprovalData(approvalObj, domainHash)
  
            let tx = operatorERC1155Contract.functions.metaSetApprovalForAll(ownerAddress, operatorAddress, approved, true, data)
            await expect(tx).to.be.rejectedWith(RevertError());
          })
        })

        it("should REVERT if contract address is incorrect", async () => {
          domainHash = ethers.utils.keccak256(ethers.utils.solidityPack(
            ['bytes32', 'uint256'], 
            [DOMAIN_SEPARATOR_TYPEHASH, receiverAddress]
          ))
          data = await encodeMetaApprovalData(approvalObj, domainHash, gasReceipt)

          let tx = operatorERC1155Contract.functions.metaSetApprovalForAll(ownerAddress, operatorAddress, approved, isGasReimbursed, data)
          await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_SIGNATURE") )    
        })

        it("should REVERT if operator address is incorrect", async () => {
          approvalObj.operator = receiverAddress;   
          data = await encodeMetaApprovalData(approvalObj, domainHash, gasReceipt)

          let tx = operatorERC1155Contract.functions.metaSetApprovalForAll(ownerAddress, operatorAddress, approved, isGasReimbursed, data)
          await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_SIGNATURE") )    
        })

        it("should REVERT if approved value is incorrect", async () => {
          approvalObj.approved = false;
          data = await encodeMetaApprovalData(approvalObj, domainHash, gasReceipt)

          let tx = operatorERC1155Contract.functions.metaSetApprovalForAll(ownerAddress, operatorAddress, approved, isGasReimbursed, data)
          await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_SIGNATURE") )    
        })

        it("should REVERT if nonce is incorrect", async () => {
          approvalObj.nonce = nonce.add(101);
          data = await encodeMetaApprovalData(approvalObj, domainHash, gasReceipt)

          // Nonce higher
          let tx = operatorERC1155Contract.functions.metaSetApprovalForAll(ownerAddress, operatorAddress, approved, isGasReimbursed, data)
          await expect(tx).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_NONCE") )   
          
          // Correct nonce
          approvalObj.nonce = nonce
          data = await encodeMetaApprovalData(approvalObj, domainHash, gasReceipt)
          await operatorERC1155Contract.functions.metaSetApprovalForAll(ownerAddress, operatorAddress, approved, isGasReimbursed, data)

          // Nonce lower
          const tx2 = operatorERC1155Contract.functions.metaSetApprovalForAll(ownerAddress, operatorAddress, approved, isGasReimbursed, data)
          await expect(tx2).to.be.rejectedWith( RevertError("ERC1155Meta#_signatureValidation: INVALID_NONCE") ) 
        })


        it('should emit an ApprovalForAll event', async () => {
          let tx = await operatorERC1155Contract.functions.metaSetApprovalForAll(ownerAddress, operatorAddress, approved, isGasReimbursed, data)
          const receipt = await tx.wait(1)

          expect(receipt.events![1].event).to.be.eql('ApprovalForAll')
        })

        it('should set the operator status to _status argument', async () => {
          let tx = operatorERC1155Contract.functions.metaSetApprovalForAll(ownerAddress, operatorAddress, approved, isGasReimbursed, data)
          await expect(tx).to.be.fulfilled

          const status = await erc1155Contract.functions.isApprovedForAll(ownerAddress, operatorAddress)
          expect(status).to.be.eql(true)
        })

        it('should emit NonceChange event', async () => {
          let tx = await operatorERC1155Contract.functions.metaSetApprovalForAll(ownerAddress, operatorAddress, approved, isGasReimbursed, data)
          const receipt = await tx.wait(1)
          const ev = receipt.events![0]
          expect(ev.event).to.be.eql('NonceChange')
        })

        it('should have `_signer` as `signer` in NonceChange', async () => {
          let tx = await operatorERC1155Contract.functions.metaSetApprovalForAll(ownerAddress, operatorAddress, approved, isGasReimbursed, data)
          const receipt = await tx.wait(1)
          const ev = receipt.events![0]

          const args = ev.args! as any
          expect(args.signer).to.be.eql(ownerWallet.address)
        })

        it('should have `nonce` as `nonce + 1` in NonceChange', async () => {
          let tx = await operatorERC1155Contract.functions.metaSetApprovalForAll(ownerAddress, operatorAddress, approved, isGasReimbursed, data)
          const receipt = await tx.wait(1)
          const ev = receipt.events![0]

          const args = ev.args! as any
          expect(args.newNonce).to.be.eql(nonce.add(1))
        })

        context('When the operator was already an operator', () => {
          beforeEach(async () => {
            let tx = await operatorERC1155Contract.functions.metaSetApprovalForAll(ownerAddress, operatorAddress, approved, isGasReimbursed, data)

            // Update nonce of approval signature object for subsequent tests
            approvalObj.nonce = nonce.add(1);
          })

          it('should leave the operator status to set to true again', async () => {
            data = await encodeMetaApprovalData(approvalObj, domainHash, gasReceipt)

            let tx = operatorERC1155Contract.functions.metaSetApprovalForAll(ownerAddress, operatorAddress, approved, isGasReimbursed, data)
            await expect(tx).to.be.fulfilled

            const status = await erc1155Contract.functions.isApprovedForAll(ownerAddress, operatorAddress)
            expect(status).to.be.eql(true)
          })

          it('should allow the operator status to be set to false', async () => {
            approvalObj.approved = false;
            data = await encodeMetaApprovalData(approvalObj, domainHash, gasReceipt)

            let tx = operatorERC1155Contract.functions.metaSetApprovalForAll(ownerAddress, operatorAddress, false, isGasReimbursed, data)
            await expect(tx).to.be.fulfilled

            const status = await erc1155Contract.functions.isApprovedForAll(operatorAddress, ownerAddress)
            expect(status).to.be.eql(false)
          })
        })

      })
    })
  })
})