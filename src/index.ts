// Facade

export { Divigent } from './divigent';
export type {
  DepositParams,
  DepositWithPermitParams,
  DivigentConfig,
  SetOperatorParams,
  SignInitializeForParams,
  SignPermitParams,
  WithdrawParams,
} from './divigent';

// Chains and address registry

export {
  CHAINS,
  ZERO_ADDRESS,
  assertProtocolDeployed,
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
  PaymentContext,
  PaymentCreatedContext,
  X402PolicyContext,
  X402ResourceCap,
  X402ResourcePattern,
  X402WrapConfig,
} from './x402/types';

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
  OperatorAckRequiredError,
  PanicError,
  PaymentCapExceededError,
  PermitUnsupportedFor7702AccountError,
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
// Public x402 onboarding is intentionally via `divigent.attachTo(x402Client)`.
// Lower-level hook/fetch/settlement helpers remain internal for now so
// `@divigent/sdk` stays small and obvious for non-DeFi integrators.

// Raw ABIs for advanced typed viem interactions

export { routerAbi, oracleAbi, feeCollectorAbi, dvUsdcAbi, usdcAbi } from './abis';
