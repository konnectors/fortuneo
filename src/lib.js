const {
  requestFactory,
  updateOrCreate,
  log,
  scrape,
  signin,
  categorize,
  cozyClient,
  errors
} = require('cozy-konnector-libs')

const groupBy = require('lodash/groupBy')
const omit = require('lodash/omit')
const moment = require('moment')
const AdmZip = require('adm-zip')

const helpers = require('./helpers')

const doctypes = require('cozy-doctypes')
const {
  Document,
  BankAccount,
  BankTransaction,
  BalanceHistory,
  BankingReconciliator
} = doctypes

// ------

let baseUrl = 'https://mabanque.fortuneo.fr'
let urlLogin = baseUrl + '/fr/identification.jsp'
let urlAskDownload =
  baseUrl +
  '/fr/prive/mes-comptes/compte-courant/consulter-situation/telecharger-historique/telechargement-especes.jsp'
let urlDownload = baseUrl + '/documents/HistoriqueOperations_'

Document.registerClient(cozyClient)

const reconciliator = new BankingReconciliator({ BankAccount, BankTransaction })
const request = requestFactory({
  // debug: true,
  cheerio: true,
  json: false,
  jar: true
})

let lib

/**
 * The start function is run by the BaseKonnector instance only when it got all the account
 * information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
 * the account information come from ./konnector-dev-config.json file
 * @param {object} fields
 */
async function start(fields) {
  log('info', 'Authenticating ...')
  const $ = await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')

  log('info', 'Parsing list of bank accounts')
  const bankAccounts = await lib.parseBankAccounts($)

  log('info', 'Retrieve all informations for each bank accounts found')

  // Build the date range of the retrieved operations.
  // Note: for some reasons, Fortuneo only allows to retrieve 2 years of operations.
  const today = moment().format('DD/MM/YYYY')
  const lastTwoYears = moment()
    .subtract(2, 'years')
    .format('DD/MM/YYYY')

  let allOperations = []
  for (let bankAccount of bankAccounts) {
    log('info', 'Retrieve the balance', 'bank.balances')
    // Update the balance of each bank account
    // Note: the parameter is a pointer
    const balance = await parseBalances(bankAccount)
    if (balance) bankAccount.balance = balance

    log('info', 'Download CSV', 'bank.operations')
    let csv = await downloadCSVWithBankInformation(
      lastTwoYears,
      today,
      bankAccount
    )
    allOperations = allOperations.concat(lib.parseOperations(bankAccount, csv))
  }

  log('info', 'Categorize the list of transactions')
  const categorizedTransactions = await categorize(allOperations)

  // Save the accounts, omitting unnecessary data
  const { accounts: savedAccounts } = await reconciliator.save(
    bankAccounts.map(x => omit(x, ['currency', 'accountType', 'linkBalance'])),
    categorizedTransactions
  )

  log(
    'info',
    'Retrieve the balance histories and adds the balance of the day for each bank accounts'
  )
  const balances = await fetchBalances(savedAccounts)

  log('info', 'Save the balance histories')
  await lib.saveBalances(balances)
}

/**
 * This function initiates a connection on the Fortuneo website.
 *
 * @param {string} login
 * @param {string} passwd Password
 * @see {@link https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#module_signin}
 * @returns {boolean} Returns true if authentication is successful, else false
 */
function authenticate(login, passwd) {
  return signin({
    url: urlLogin,
    formSelector: 'form[name="acces_identification"]',
    formData: { login, passwd },
    encoding: 'latin1',
    validate: (statusCode, $, fullResponse) => {
      // First check if 2FA code is requested
      if (fullResponse.body.includes('Sécurité renforcée tous les 90 jours')) {
        throw new Error(errors.USER_ACTION_NEEDED)
      }

      // Then check if there is at least one logout link
      return $('a[href="/logoff"]').length > 0
    }
  })
}

/**
 * Downloads an CSV file with the transactions registered during the selected period for
 * an bank account.
 *
 * @returns {array} The lines of the CSV file
 */
async function downloadCSVWithBankInformation(dateBegin, dateEnd, bankAccount) {
  const rq = requestFactory({
    // debug: 'full',
    cheerio: false,
    gzip: false,
    jar: true
  })

  let csv = []
  let formData = {
    formatSelectionner: 'csv',
    dateRechercheDebut: dateBegin,
    dateRechercheFin: dateEnd,
    triEnDate: 0
  }

  // Workflow:
  // 1. Request to prepare an archive with all operations registered during the selected period.
  // 2. If successful, download the prepared archive (.zip) containing a CSV file
  // 2.1 Parse the CSV file found and return the result

  return await rq({
    method: 'POST',
    uri: urlAskDownload,
    transform: (body, response) => [response.statusCode, body],
    encoding: 'latin1',
    form: formData
  })
    .then(([statusCode, body]) => {
      if (statusCode !== 200 || !body.match(/Lancer le téléchargement/g))
        return csv

      // Adds bank account number in body request
      formData['noCompteSelectionner'] = bankAccount.number

      return rq({
        uri: urlDownload + bankAccount.number + '.zip',
        encoding: null,
        form: formData
      }).then(body => {
        let zip = new AdmZip(body)
        let zipEntries = zip.getEntries()

        zipEntries.forEach(entry => {
          // Ignore all files are not a csv
          if (entry.entryName.match(/\.csv$/i)) {
            csv = zip.readAsText(entry).split('\r\n')

            // Can only handle one CSV file, so don't continue
            return csv
          }
        })

        return csv
      })
    })
    .catch(helpers.handleRequestErrors)
}

/**
 * Retrieves all the bank accounts of the user from HTML.
 *
 * @param {object} $ DOM parsed by {@link https://cheerio.js.org/|Cheerio}
 * @see {@link https://github.com/konnectors/libs/blob/master/packages/cozy-konnector-libs/docs/api.md#scrape}
 *
 * @example
 * parseBankAccounts($);
 *
 * // [
 * //   {
 * //     institutionLabel: 'Fortuneo Banque',
 * //     label: 'LIVRET',
 * //     type: 'Savings',
 * //     balance: 42,
 * //     number: 'XXXXXXXX',
 * //     vendorId: 'XXXXXXXX',
 * //     linkBalance: '...',
 * //     accountType: 4,
 * //     currency: 'EUR'
 * //   }
 * // ]
 *
 * @returns {array} Collection of
 * {@link https://docs.cozy.io/en/cozy-doctypes/docs/io.cozy.bank/#iocozybankaccounts|io.cozy.bank.accounts}
 */
function parseBankAccounts($) {
  const accounts = scrape(
    $,
    {
      number: {
        sel: 'a>div',
        parse: body => body.split(' ')[1]
      },
      label: {
        sel: 'a',
        attr: 'title',
        parse: body => body.toUpperCase()
      },
      accountType: {
        attr: 'class',
        parse: helpers.getAccountTypeFromCSS
      },
      linkBalance: {
        sel: 'a',
        attr: 'href'
      }
    },
    '#menu_mes_comptes ul div.compte'
  )

  accounts.forEach(account => {
    account.institutionLabel = 'Fortuneo Banque'
    account.balance = 0
    account.vendorId = account.number
    account.currency = 'EUR'
    account.type = account.accountType.type
  })

  return accounts
}

/**
 * Parses and transforms each lines (CSV format) into
 * {@link https://docs.cozy.io/en/cozy-doctypes/docs/io.cozy.bank/#iocozybankoperations|io.cozy.bank.operations}
 * @param {io.cozy.bank.accounts} account Bank account
 * @param {array} operationLines Lines containing operation information for the current bank account - CSV format expected
 *
 * @example
 * var account = {
 *    institutionLabel: 'Fortuneo Banque',
 *    label: 'LIVRET',
 *    type: 'Savings',
 *    balance: 42,
 *    number: 'XXXXXXXX',
 *    vendorId: 'XXXXXXXX',
 *    linkBalance: '...',
 *    accountType: 4,
 *    currency: 'EUR'
 * };
 *
 * var csv = [
 *    'Date;Valeur;Libellé;Débit;Crédit;', // ignored
 *    // Transaction(s)
 *    '31/12/18;01/01/19;INTERETS 2018;;38,67;',
 *    // End transaction(s)
 *    '...','...','...','' // ignored
 * ];
 *
 * parseOperations(account, csv);
 * // [
 * //   {
 * //     label: 'INTERETS 2018',
 * //     type: 'direct debit',
 * //     cozyCategoryId: '200130',
 * //     cozyCategoryProba: 1,
 * //     date: "2018-12-30T23:00:00+01:00",            (UTC)
 * //     dateOperation: "2018-12-31T23:00:00+01:00",   (UTC)
 * //     dateImport: "2019-04-17T10:07:30.553Z",       (UTC)
 * //     currency: 'EUR',
 * //     vendorAccountId: 'XXXXXXXX',
 * //     amount: 38.67,
 * //     vendorId: 'XXXXXXXX_2018-12-30_0'             {number}_{date}_{index}
 * //   }
 *
 * @returns {array} Collection of {@link https://docs.cozy.io/en/cozy-doctypes/docs/io.cozy.bank/#iocozybankoperations|io.cozy.bank.operations}.
 */
function parseOperations(account, operationLines) {
  const operations = operationLines
    .slice(1)
    .filter(line => {
      return line.length > 5 // avoid lines with empty cells
    })
    .map(line => {
      const cells = line.split(';')

      // Remove the Unicode Replacement Character
      // Info: http://www.fileformat.info/info/unicode/char/fffd/index.htm
      let label = cells[2].replaceAll('\uFFFD', ' ')
      const words = label.split(' ')
      let metadata = null

      const date = helpers.parseDate(cells[0])
      const dateOperation = helpers.parseDate(cells[1])

      let amount = 0
      if (cells[3].length) {
        amount = helpers.normalizeAmount(cells[3])
        metadata = helpers.findMetadataForDebitOperation(words)
      } else if (cells[4].length) {
        amount = helpers.normalizeAmount(cells[4])
        metadata = helpers.findMetadataForCreditOperation(words)
      } else {
        log('error', cells, 'Could not find an amount in this operation')
      }

      return {
        label: label,
        type: metadata._type || 'none',
        date: date.format(),
        dateOperation: dateOperation.format(),
        dateImport: new Date().toISOString(),
        currency: account.currency,
        vendorAccountId: account.number,
        amount: amount
      }
    })

  // Forge a vendorId by concatenating account number, day YYYY-MM-DD and index
  // of the operation during the day
  const groups = groupBy(operations, x => x.date.slice(0, 10))
  Object.entries(groups).forEach(([date, group]) => {
    group.forEach((operation, i) => {
      operation.vendorId = `${account.vendorId.replaceAll(
        /\s/,
        '_'
      )}_${date}_${i}`
    })
  })

  return operations
}

/**
 * Retrieves the balance of an bank account.<br><br>
 *
 * <strong>Note</strong>: This function uses the pointer given in parameter to update the balance.
 * That is why it doesn't return anything.
 *
 * @param {object} bankAccounts (pointer)
 */
async function parseBalances(bankAccount) {
  let $ = await request(`${baseUrl}${bankAccount.linkBalance}`)
  // Access to the account might be blocked by a pop-up requesting
  // to update the client's "investor profile", which is mandatory
  // for clients investing in stocks or life-insurance.
  if ($.html().includes('ProfilInvestisseurForm')) {
    throw new Error(errors.USER_ACTION_NEEDED)
  }
  let rules = bankAccount.accountType.scrape4Balance
  return rules ? scrape($(rules.sel), { value: rules.opts }).value : undefined
}

/**
 * Retrieves the balance histories of each bank accounts and adds the balance of the day for each bank account.
 * @param {array} accounts Collection of {@link https://docs.cozy.io/en/cozy-doctypes/docs/io.cozy.bank/#iocozybankaccounts|io.cozy.bank.accounts}
 * already registered in database
 *
 * @example
 * var accounts = [
 *    {
 *      _id: '12345...',
 *      _rev: '14-98765...',
 *      _type: 'io.cozy.bank.accounts',
 *      balance: 42,
 *      cozyMetadata: { updatedAt: '2019-04-17T10:07:30.769Z' },
 *      institutionLabel: 'Fortuneo Banque',
 *      label: 'LIVRET',
 *      number: 'XXXXXXXX',
 *      rawNumber: 'XXXXXXXX',
 *      type: 'Savings',
 *      vendorId: 'XXXXXXXX'
 *    }
 * ];
 *
 *
 * fetchBalances(accounts);
 *
 * // [
 * //   {
 * //     _id: '12345...',
 * //     _rev: '9-98765...',
 * //     balances: { '2019-04-16': 42, '2019-04-17': 42 },
 * //     metadata: { version: 1 },
 * //     relationships: { account: [Object] },
 * //     year: 2019
 * //   }
 * // ]
 *
 * @returns {array} Collection of {@link https://docs.cozy.io/en/cozy-doctypes/docs/io.cozy.bank/#iocozybankbalancehistories|io.cozy.bank.balancehistories}
 * registered in database
 */
function fetchBalances(accounts) {
  const now = moment()
  const todayAsString = now.format('YYYY-MM-DD')
  const currentYear = now.year()

  return Promise.all(
    accounts.map(async account => {
      const history = await BalanceHistory.getByYearAndAccount(
        currentYear,
        account._id
      )
      history.balances[todayAsString] = account.balance

      return history
    })
  )
}

/**
 * Saves the balance histories in database.
 *
 * @param balances Collection of {@link https://docs.cozy.io/en/cozy-doctypes/docs/io.cozy.bank/#iocozybankbalancehistories|io.cozy.bank.balancehistories}
 * to save in database
 * @returns {Promise}
 */
function saveBalances(balances) {
  return updateOrCreate(balances, 'io.cozy.bank.balancehistories', ['_id'])
}

// ===== Export ======

String.prototype.replaceAll = function(search, replacement) {
  var target = this
  return target.replace(new RegExp(search, 'g'), replacement)
}

module.exports = lib = {
  start,
  authenticate,
  parseBankAccounts,
  parseOperations,
  fetchBalances,
  saveBalances
}
