const moment = require('moment')
const rerrors = require('request-promise/errors')
const { log, errors } = require('cozy-konnector-libs')

const classification = require('../classification.json')

// ====== Constants =======

const defaultMedataOperation = {
  _id: '0',
  _proba: 0,
  _type: 'none'
}

const AccountType = {
  UNKNOWN: {
    id: 0,
    type: 'Unknown',
    scrape4Balance: null
  },
  CHECKINGS: {
    id: 1,
    type: 'Checkings',
    scrape4Balance: {
      sel: '#tableauConsultationHisto',
      opts: { sel: 'td>strong', parse: normalizeAmount }
    }
  },
  CREDITCARD: {
    id: 2,
    type: 'CreditCard',
    scrape4Balance: {
      sel: '#tableauConsultationHisto',
      opts: { sel: 'td>a>strong', parse: normalizeAmount }
    }
  },
  SAVINGS: {
    id: 3,
    type: 'Savings',
    scrape4Balance: {
      sel: 'div.synthese_livret_cat a',
      opts: { sel: 'p.synthese_data_line_right_text', parse: normalizeAmount }
    }
  },
  MARKET: {
    id: 4,
    type: 'Market',
    scrape4Balance: {
      sel: '#valorisation_compte>table>tbody>tr',
      opts: { sel: 'td.gras', parse: normalizeAmount }
    }
  },
  LIFEINSURANCE: {
    id: 5,
    type: 'LifeInsurance',
    scrape4Balance: {
      sel: 'div.synthese_vie>div>div.colonne_gauche>div>p>span',
      opts: { sel: 'strong', parse: normalizeAmount }
    }
  }
}

const AbbrToAccountType = {
  cco: AccountType.CHECKINGS,
  esp: AccountType.CHECKINGS,
  liv_a: AccountType.SAVINGS,
  liv_d: AccountType.SAVINGS,
  liv_p: AccountType.SAVINGS,
  ord: AccountType.MARKET,
  pea: AccountType.MARKET,
  vie: AccountType.LIFEINSURANCE
}

// ====== Public functions =======

/**
 * Convert string to {@link moment.Moment}
 * @param {string} date
 * @returns {moment.Moment}
 */
function parseDate(date) {
  moment.locale('fr')
  return moment(date, 'DD/MM/YYYY')
}

/**
 * Convert an amount to float, by keeping in the input string only
 * digits, separators, and +/- indicators.
 * @param {string} amount
 * @returns {Number}
 */
function normalizeAmount(amount) {
  return parseFloat(
    amount
      .replaceAll(/[^\d,.\-+]/, '')
      .replace(',', '.')
      .trim()
  )
}

/**
 * Analyzes the CSS classes of the bank account to find its type
 *
 * @param {string} label The CSS classes of the bank account
 * @see {@link https://docs.cozy.io/en/cozy-doctypes/docs/io.cozy.bank/#iocozybankaccounts|io.cozy.bank.accounts}
 * @returns {string} The type of the bank account
 */
function getAccountTypeFromCSS(cssClasses) {
  let cssClass = cssClasses.split(' ')

  // Keep only the first class: e.g. 'cco compte' -> 'cco'
  return AbbrToAccountType[cssClass[0]] || AccountType.UNKNOWN
}

/**
 * Searches in the classification.json file, the metadata corresponding to words passed in parameters.
 * This function ignores the metadata dedicated to debit operations.
 *
 * @param {array} words
 * @returns {object}
 */
function findMetadataForCreditOperation(words) {
  return _classification(words, defaultMedataOperation, (tree, metadata) =>
    _readSpecificMetaData(tree, '_credit', metadata)
  )
}

/**
 * Searches in the classification.json file, the metadata corresponding to words passed in parameters.
 * This function ignores the metadata dedicated to credit operations.
 *
 * @param {array} words
 * @returns {object}
 */
function findMetadataForDebitOperation(words) {
  return _classification(words, defaultMedataOperation, (tree, metadata) =>
    _readSpecificMetaData(tree, '_debit', metadata)
  )
}

/**
 *
 * @param err
 * @returns {Promise.<*>}
 */
function handleRequestErrors(err) {
  if (
    err instanceof rerrors.RequestError ||
    err instanceof rerrors.StatusCodeError
  ) {
    log('error', err)
    throw new Error(errors.VENDOR_DOWN)
  } else {
    return Promise.reject(err)
  }
}

// ====== Private functions =======

function _classification(words, metadata, fnReadMetadata) {
  let treeActive = classification[words[0].toUpperCase()]
  if (!treeActive) {
    return metadata
  }

  let index = words[0] === 'CARTE' ? 2 : 1

  fnReadMetadata(treeActive, metadata)

  for (let word of words.slice(index)) {
    let tree = treeActive[word.toUpperCase()]

    if (!tree) {
      return metadata
    }

    fnReadMetadata(tree, metadata)
    treeActive = tree
  }
}

function _readDefaultMetaData(treeMetadata, metadata) {
  Object.keys(metadata).forEach(key => {
    if (treeMetadata[key]) metadata[key] = treeMetadata[key]
  })
}

function _readSpecificMetaData(treeMetadata, typeOperation, metadata) {
  _readDefaultMetaData(treeMetadata, metadata)

  if (treeMetadata[typeOperation]) {
    _readDefaultMetaData(treeMetadata[typeOperation], metadata)
  }
  return metadata
}

// ====== Export =======

module.exports = {
  AccountType,
  parseDate,
  normalizeAmount,
  handleRequestErrors,
  getAccountTypeFromCSS,
  findMetadataForCreditOperation,
  findMetadataForDebitOperation
}
