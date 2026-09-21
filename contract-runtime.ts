// Augur `contract-wrap` の import 先をリポジトリ直下にも置くための再輸出。
//
// `augur.contracts.json` の `importFrom` は注入先の深さに関係なく同じ文字列
// (`../contract-runtime.ts`) が全ての注入点へ書き込まれる。 この相対指定は
// `server/face/*.ts` からは `server/contract-runtime.ts` に、 `server/*.ts` からは
// このファイルに解決される。 実体は 1 つ (server/contract-runtime.ts) のままにして、
// 浅い側の解決先をここで埋める。 手で import 行を書き換えると次の
// `augur inject apply` が別指定とみなして二重に import を足すので、 ここで吸収する。

export {
  contract,
  resetContractObservation,
  type ContractPredicates,
  type ContractSpec,
  type ContractVerdict,
} from './server/contract-runtime.ts';
