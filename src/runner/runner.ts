import { DiagnosticSeverity, Optional } from '@stoplight/types';
import { JSONPathCallback } from 'jsonpath-plus';
import { flatMap } from 'lodash';
import { JSONPathExpression, traverse } from 'nimma';

import { STDIN } from '../document';
import { DocumentInventory } from '../documentInventory';
import { OptimizedRule, Rule } from '../rule';
import { IGivenNode, IRuleResult } from '../types';
import { generateDocumentWideResult } from '../utils/generateDocumentWideResult';
import { lintNode } from './linter';
import { IRunnerInternalContext, IRunnerPublicContext } from './types';
import { IExceptionLocation, pivotExceptions } from './utils/pivotExceptions';

const { JSONPath } = require('jsonpath-plus');

const isStdInSource = (inventory: DocumentInventory): boolean => {
  return inventory.document.source === STDIN;
};

const generateDefinedExceptionsButStdIn = (documentInventory: DocumentInventory): IRuleResult => {
  return generateDocumentWideResult(
    documentInventory.document,
    'The ruleset contains `except` entries. However, they cannot be enforced when the input is passed through stdin.',
    DiagnosticSeverity.Warning,
    'except-but-stdin',
  );
};

export const runRules = async (context: IRunnerPublicContext): Promise<IRuleResult[]> => {
  const { documentInventory, rules, exceptions } = context;

  const runnerContext: IRunnerInternalContext = {
    ...context,
    results: [],
    promises: [],
  };

  const isStdIn = isStdInSource(documentInventory);
  const exceptRuleByLocations = isStdIn ? {} : pivotExceptions(exceptions, rules);

  if (isStdIn && Object.keys(exceptions).length > 0) {
    runnerContext.results.push(generateDefinedExceptionsButStdIn(documentInventory));
  }

  const relevantRules = Object.values(rules).filter(
    rule => rule.enabled && rule.matchesFormat(documentInventory.formats),
  );

  const optimizedRules: OptimizedRule[] = [];
  const optimizedUnresolvedRules: OptimizedRule[] = [];
  const unoptimizedRules: Rule[] = [];

  const traverseCb = (rule: OptimizedRule, node: IGivenNode) => {
    lintNode(runnerContext, node, rule, exceptRuleByLocations[rule.name]);
  };

  for (const rule of relevantRules) {
    if (!(rule instanceof OptimizedRule)) {
      unoptimizedRules.push(rule);
      continue;
    }

    if (rule.resolved) {
      optimizedRules.push(rule);
    } else {
      optimizedUnresolvedRules.push(rule);
    }

    rule.hookup(traverseCb);
  }

  if (optimizedRules.length > 0) {
    traverse(Object(runnerContext.documentInventory.resolved), flatMap(optimizedRules, pickExpressions));
  }

  if (optimizedUnresolvedRules.length > 0) {
    traverse(Object(runnerContext.documentInventory.unresolved), flatMap(optimizedUnresolvedRules, pickExpressions));
  }

  for (const rule of unoptimizedRules) {
    try {
      runRule(runnerContext, rule, exceptRuleByLocations[rule.name]);
    } catch (ex) {
      console.error(ex);
    }
  }

  if (runnerContext.promises.length > 0) {
    await Promise.all(runnerContext.promises);
  }

  return runnerContext.results;
};

const runRule = (
  context: IRunnerInternalContext,
  rule: Rule,
  exceptRuleByLocations: Optional<IExceptionLocation[]>,
): void => {
  const target = rule.resolved ? context.documentInventory.resolved : context.documentInventory.unresolved;

  for (const given of rule.given) {
    // don't have to spend time running jsonpath if given is $ - can just use the root object
    if (given === '$') {
      lintNode(
        context,
        {
          path: ['$'],
          value: target,
        },
        rule,
        exceptRuleByLocations,
      );
    } else {
      JSONPath({
        path: given,
        json: target,
        resultType: 'all',
        callback: (result => {
          lintNode(
            context,
            {
              path: JSONPath.toPathArray(result.path),
              value: result.value,
            },
            rule,
            exceptRuleByLocations,
          );
        }) as JSONPathCallback,
      });
    }
  }
};

function pickExpressions({ expressions }: OptimizedRule): JSONPathExpression[] {
  return expressions;
}
