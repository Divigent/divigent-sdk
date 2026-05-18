// Facade

export { Divigent } from './divigent';
export type {
  ApproveUsdcPlan,
  DepositParams,
  DepositPlan,
  DepositWithPermitParams,
  DivigentConfig,
  DivigentTransactionPlan,
  DivigentWriteRequest,
  EnsureInitializedParams,
  SetOperatorParams,
  SignInitializeForParams,
  SignPermitParams,
  WithdrawPlan,
  WithdrawParams,
} from './divigent';

// Chains and address registry

export {
  CHAINS,
  ZERO_ADDRESS,
  assertProtocolDeployed,
  chainFromId,
  getAddresses,
  getChainConfig,
  isZeroAddress,
} from './core/chains';
export type {
  ChainConfig,
  ContractAddresses,
  DivigentChain,
} from './core/chains';

// Shared types

export {
  evmAddress,
  txHash,
} from './types';
export type {
  DepositResult,
  EvmAddress,
  FeeOverrides,
  OptimalVault,
  OracleStatus,
  PermitSig,
  Position,
  Prettify,
  TreasuryStatus,
  TxHash,
  TxResult,
  VaultAllocation,
  VaultCapacity,
  VaultRate,
  VaultType,
  WithdrawResult,
  WaitOptions,
} from './types';
export type {
  FailureContext,
  IdleDepositContext,
  PaymentContext,
  PaymentCreatedContext,
  X402AttachHandle,
  X402AutoDepositOptions,
  X402IdleDepositOptions,
  X402IncomeAttachHandle,
  X402IncomeConfig,
  X402PolicyContext,
  X402ResourceCap,
  X402ResourcePattern,
  X402WrapConfig,
} from './x402/types';
export {
  X402_USDC_EXTRA_BY_CHAIN,
  x402UsdcExtra,
  x402UsdcPrice,
} from './x402/usdc';
export type {
  X402AssetTransferMethod,
  X402UsdcExtra,
  X402UsdcPrice,
} from './x402/usdc';

// Utils

export {
  applyBps,
  applyFee,
  applySlippageDown,
  bigintAbs,
  bigintMax,
  bigintMin,
  BPS_DENOMINATOR,
  convertToAssets,
  convertToShares,
  DIVIGENT_FEE_BPS,
  formatUsdc,
  parseUsdc,
  rescaleDecimals,
  toDisplayString,
  USDC_DECIMALS,
} from './core/utils';
export type { Rounding } from './core/utils';

// Errors

export {
  AddressMismatchError,
  AlreadyAttachedError,
  ChainMismatchError,
  DivigentError,
  MinDepositNotMetError,
  OperatorAckRequiredError,
  PanicError,
  PaymentCapExceededError,
  PermitUnsupportedFor7702AccountError,
  PermitUnsupportedForTokenError,
  ReceiptParseError,
  RequireError,
  ContractRevertError,
  UserRejectedError,
  ZeroAddressError,
  decodeDivigentError,
  extractRevertData,
  isDivigentError,
  toDivigentError,
  wrapViemError,
} from './errors';
export type {
  DivigentErrorCategory,
  DivigentErrorOptions,
  ToDivigentErrorOptions,
} from './errors';

// Receipt parsing

export {
  parseDepositReceipt,
  parseWithdrawReceipt,
} from './core/receipts';

// x402 integration
// Public x402 onboarding is via `divigent.attachTo(x402Client)` for buyers
// and `divigent.attachToResourceServer(resourceServer)` for sellers. Lower-level
// hook/fetch/settlement helpers remain internal so the package stays small.

// Raw ABIs for advanced typed viem interactions

export { routerAbi, oracleAbi, feeCollectorAbi, dvUsdcAbi, usdcAbi } from './abis';
