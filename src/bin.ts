#!/usr/bin/env node

import { join, resolve } from 'path';
import { start, Recoverable } from 'repl';
import { inspect } from 'util';
import Module = require('module');
import arg = require('arg');
import { diffLines } from 'diff';
import { Script, createContext, runInContext } from 'vm';
import { readFileSync, statSync } from 'fs';
import { register, VERSION, DEFAULTS, TSError, parse } from './index';
import { V4MAPPED } from 'dns';

const cwd = process.cwd()
const help = false
const version = 0
const files = DEFAULTS.files
const compiler = DEFAULTS.compiler
const compilerOptions = DEFAULTS.compilerOptions
const project = DEFAULTS.project
const ignoreDiagnostics = DEFAULTS.ignoreDiagnostics
const ignore = DEFAULTS.ignore
const transpileOnly = DEFAULTS.transpileOnly
const typeCheck = DEFAULTS.typeCheck
const pretty = DEFAULTS.pretty
const skipProject = DEFAULTS.skipProject
const skipIgnore = DEFAULTS.skipIgnore

// Register the TypeScript compiler instance.
const service = register({
  files,
  pretty,
  typeCheck,
  transpileOnly,
  ignore,
  project,
  skipIgnore,
  skipProject,
  compiler,
  ignoreDiagnostics,
  compilerOptions,
  readFile: readFileEval,
  fileExists: fileExistsEval
})

/**
 * Eval helpers.
 */
const EVAL_FILENAME = `[eval].ts`
const EVAL_PATH = join(cwd, EVAL_FILENAME)
const EVAL_INSTANCE = { input: '', output: '', version: 0, lines: 0 }

// Execute the main contents (either eval, script or piped).

startRepl()

/**
 * Evaluate the code snippet.
 */
function _eval (input: string) {
  const lines = EVAL_INSTANCE.lines
  const isCompletion = !/\n$/.test(input)
  const undo = appendEval(input)
  let output: string

  try {
    output = service.compile(EVAL_INSTANCE.input, EVAL_PATH, -lines)
  } catch (err) {
    undo()
    throw err
  }

  // Use `diff` to check for new JavaScript to execute.
  const changes = diffLines(EVAL_INSTANCE.output, output)

  if (isCompletion) {
    undo()
  } else {
    EVAL_INSTANCE.output = output
  }

  return changes.reduce((result, change) => {
    return change.added ? exec(change.value, EVAL_FILENAME) : result
  }, undefined)
}

/**
 * Execute some code.
 */
function exec (code: string, filename: string) {
  const script = new Script(code, { filename: filename })

  return script.runInThisContext()
}

/**
 * Start a CLI REPL.
 */
function startRepl () {
  const mainFile = readFileSync('/home/runner/index.ts').toString('utf-8')
  _eval(mainFile)

  const repl = start({
    // \u001b[33m\u001b[00m
    prompt: '> ',
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdout.isTTY,
    eval: replEval,
    useGlobal: true
  })



  // Bookmark the point where we should reset the REPL state.
  const resetEval = appendEval('')

  function reset () {
    resetEval()

    // Hard fix for TypeScript forcing `Object.defineProperty(exports, ...)`.
    exec('exports = module.exports', EVAL_FILENAME)
  }

  reset()
  repl.on('reset', reset)

  repl.defineCommand('type', {
    help: 'Check the type of a TypeScript identifier',
    action: function (identifier: string) {
      if (!identifier) {
        repl.displayPrompt()
        return
      }

      const undo = appendEval(identifier)
      const { name, comment } = service.getTypeInfo(
        EVAL_INSTANCE.input,
        EVAL_PATH,
        EVAL_INSTANCE.input.length
      )

      undo()

      repl.outputStream.write(`${name}\n${comment ? `${comment}\n` : ''}`)
      repl.displayPrompt()
    }
  })
}

/**
 * Eval code from the REPL.
 */
function replEval (
  code: string,
  _context: any,
  _filename: string,
  callback: (err: Error | null, result?: any) => any
) {
  let err: Error | null = null
  let result: any

  // TODO: Figure out how to handle completion here.
  if (code === '.scope') {
    callback(err)
    return
  }

  try {
    result = _eval(code)
  } catch (error) {
    if (error instanceof TSError) {
      // Support recoverable compilations using >= node 6.
      if (Recoverable && isRecoverable(error)) {
        err = new Recoverable(error)
      } else {
        console.error(error.diagnosticText)
      }
    } else {
      err = error
    }
  }

  callback(err, result)
}

/**
 * Append to the eval instance and return an undo function.
 */
function appendEval (input: string) {
  const undoInput = EVAL_INSTANCE.input
  const undoVersion = EVAL_INSTANCE.version
  const undoOutput = EVAL_INSTANCE.output
  const undoLines = EVAL_INSTANCE.lines

  // Handle ASI issues with TypeScript re-evaluation.
  if (
    undoInput.charAt(undoInput.length - 1) === '\n' &&
    /^\s*[\[\(\`]/.test(input) &&
    !/;\s*$/.test(undoInput)
  ) {
    EVAL_INSTANCE.input = `${EVAL_INSTANCE.input.slice(0, -1)};\n`
  }

  EVAL_INSTANCE.input += input
  EVAL_INSTANCE.lines += lineCount(input)
  EVAL_INSTANCE.version++

  return function () {
    EVAL_INSTANCE.input = undoInput
    EVAL_INSTANCE.output = undoOutput
    EVAL_INSTANCE.version = undoVersion
    EVAL_INSTANCE.lines = undoLines
  }
}

/**
 * Count the number of lines.
 */
function lineCount (value: string) {
  let count = 0

  for (const char of value) {
    if (char === '\n') {
      count++
    }
  }

  return count
}

/**
 * Get the file text, checking for eval first.
 */
function readFileEval (path: string) {
  if (path === EVAL_PATH) return EVAL_INSTANCE.input

  try {
    return readFileSync(path, 'utf8')
  } catch (err) {
    /* Ignore. */
  }
}

/**
 * Get whether the file exists.
 */
function fileExistsEval (path: string) {
  if (path === EVAL_PATH) return true

  try {
    const stats = statSync(path)
    return stats.isFile() || stats.isFIFO()
  } catch (err) {
    return false
  }
}

const RECOVERY_CODES: Set<number> = new Set([
  1003, // "Identifier expected."
  1005, // "')' expected."
  1109, // "Expression expected."
  1126, // "Unexpected end of text."
  1160, // "Unterminated template literal."
  1161, // "Unterminated regular expression literal."
  2355 // "A function whose declared type is neither 'void' nor 'any' must return a value."
])

/**
 * Check if a function can recover gracefully.
 */
function isRecoverable (error: TSError) {
  return error.diagnosticCodes.every(code => RECOVERY_CODES.has(code))
}
