import { createElement, Component } from './circularDep';

import { forwardRef } from './refs';
import { getPromiseSuspendedValue } from './utils';
import {
  TRANSITION_STATE_SUSPENDED,
  TRANSITION_STATE_TIMED_OUT,
  TRANSITION_STATE_RESOLVED,
  PREDEFINED_TRANSITION_DEFERRED,
  getTransitionFromFiber,
  TRANSITION_STATE_START,
  isTransitionCompleted,
  isTransitionResolved,
} from './transitionUtils';
import { withTransition, withUpdateSource } from './updateMetaUtils';
import { deferredUpdates } from './deferredUpdates';
import reRender from './reRender';
import { BRAHMOS_DATA_KEY } from './configs';
import { getFiberFromComponent } from './fiber';

export function getClosestSuspense(fiber, includeSuspenseList) {
  const { root } = fiber;
  let { componentInstance } = fiber.node;
  while (
    !(
      componentInstance instanceof Suspense ||
      /* eslint-disable no-unmodified-loop-condition */
      (includeSuspenseList && componentInstance instanceof SuspenseList)
    )
  ) {
    fiber = fiber.parent;

    if (fiber === root) return;

    componentInstance = fiber.node.componentInstance;
  }

  return componentInstance;
}

function getActiveTransition(component) {
  const fiber = getFiberFromComponent(component);
  const currentTransition = getTransitionFromFiber(fiber);
  // console.log('+++++++++++++', currentTransition, isTransitionCompleted(currentTransition));
  return isTransitionResolved(currentTransition)
    ? PREDEFINED_TRANSITION_DEFERRED
    : currentTransition;
}

function getSuspenseManager(component, transition) {
  if (!component) return null;

  const { suspenseManagers } = component;

  const { transitionId } = transition;

  let suspenseManager = suspenseManagers[transitionId];
  if (!suspenseManager) {
    suspenseManager = suspenseManagers[transitionId] = new SuspenseManager(component, transition);
  }

  return suspenseManager;
}

class SuspenseManagerOld {
  constructor(component, transition) {
    this.component = component;
    this.transition = transition;
    this.childManagers = [];
    this.suspender = null;
    this.showFallback = true;
    this.resolved = true;
    const { parent: parentFiber } = getFiberFromComponent(component);
    this.parentSuspenseManager = getSuspenseManager(
      getClosestSuspense(parentFiber, true),
      transition,
    );
    this.rootSuspenseManager = null;
    this.recordChildSuspense();
  }

  recordChildSuspense() {
    const { parentSuspenseManager } = this;
    if (parentSuspenseManager) {
      parentSuspenseManager.childManagers.push(this);
      this.rootSuspenseManager = parentSuspenseManager.rootSuspenseManager;
    } else {
      this.rootSuspenseManager = this;
    }
  }

  resetChildSuspense() {}

  rootHasSuspendedChild() {
    const { rootSuspenseManager } = this;
    const suspenseManger = rootSuspenseManager;
    const hasSuspendedChild = !rootSuspenseManager.resolved;

    while (!hasSuspendedChild && suspenseManger) {
      suspenseManger.childManagers();
    }
  }

  getPendingManagers() {
    const { component, transition } = this;
    const { transitionId } = transition;
    const { pendingSuspenseMangers: allPendingManagers } = getFiberFromComponent(component).root;

    const pendingManagers = allPendingManagers[transitionId];

    return { allPendingManagers, pendingManagers };
  }

  addRootToProcess() {
    const { rootSuspenseManager, transition } = this;

    let { pendingManagers, allPendingManagers } = this.getPendingManagers();
    if (!pendingManagers) {
      allPendingManagers[transition.transitionId] = pendingManagers = [];
    }
    // console.log('addRootToProcess', this.transition, allPendingManagers);

    if (rootSuspenseManager && !pendingManagers.includes(rootSuspenseManager)) {
      pendingManagers.push(rootSuspenseManager);
    }
  }

  resolve(resolvedWithSuspender) {
    const {
      suspender,
      component,
      transition,
      childManagers,
      parentSuspenseManager,
      rootSuspenseManager,
    } = this;
    const { pendingManagers, allPendingManagers } = this.getPendingManagers();

    // if (resolvedWithSuspender !== suspender)
    // console.log(
    //   'old resolver',
    //   resolvedWithSuspender,
    //   suspender,
    //   resolvedWithSuspender === suspender,
    // );

    // if suspense is resolved with stale suspender return from here
    if (resolvedWithSuspender !== suspender) return;

    // mark the suspense as resolved and component as dirty
    this.resolved = true;
    component[BRAHMOS_DATA_KEY].isDirty = true;

    // if it does not have any suspender no need to do any thing and just resolve the child managers
    if (suspender) {
      const managerIndex = pendingManagers.indexOf(this.rootSuspenseManager);

      const hasUnresolvedSiblings =
        parentSuspenseManager &&
        parentSuspenseManager.childManagers.filter((managers) => !managers.resolved).length;

      // const rootManagerHasUnresolvedChild = this.rootHasSuspendedChild();

      // console.log(
      //   'Inside resolve ----',
      //   component.props.fallback.template.strings,
      //   managerIndex,
      //   pendingManagers,
      //   allPendingManagers,
      // );

      /**
       * If there are no unresolved siblings, we can resolve the
       * transition from here only, other child suspense can be resolved
       * later
       * For that remove the rootManagers from pending managers
       */
      if (!hasUnresolvedSiblings && managerIndex !== -1) {
        pendingManagers.splice(managerIndex, 1);
      }

      // reset the suspender
      this.suspender = null;

      // if there are no pending managers we can delete the transition from pending manager list
      if (pendingManagers.length === 0 && transition !== PREDEFINED_TRANSITION_DEFERRED) {
        // console.log(
        //   '-----deleting transition',
        //   transition,
        //   allPendingManagers[transition.transitionId],
        // );
        // if the transition is done with pending managers, remove the transition from pending transitions
        delete allPendingManagers[transition.transitionId];
      }

      /**
       * If a transition is timed out or completed, we need to always have to deferred update
       * A transition will come to completed state, if it is resolved by any of parent suspenders
       * And non custom transitions are timed out by default
       */
      if (isTransitionCompleted(transition)) {
        // console.log(
        //   'doing rerender',
        //   transition.transitionState === 'timedOut' && Object.keys(allPendingManagers).length === 0,
        //   allPendingManagers,
        // );
        deferredUpdates(() => reRender(component));
        /**
         * if the pendingManagers count for a transition becomes 0 it means we mark the transition as complete
         * and then do rerender.
         */
      } else if (
        pendingManagers.length === 0 &&
        transition.transitionState === TRANSITION_STATE_SUSPENDED
      ) {
        // set transition state as resolved
        transition.transitionState = TRANSITION_STATE_RESOLVED;

        withTransition(transition, () => reRender(component));
      }
    }

    // handle the child suspense after the rerender has started
    /**
     * NOTE: All child need to be resolved together
     */
    childManagers.forEach((manager) => {
      manager.handleSuspense();
    });
  }

  suspend(suspender) {
    const { component, transition } = this;
    this.resolved = false;
    this.suspender = suspender;

    this.addRootToProcess();

    const {
      root: { updateSource },
    } = getFiberFromComponent(component);

    // if (updateSource !== UPDATE_SOURCE_SUSPENSE_RESOLVE) {
    //   transition.pendingSuspense;
    // }
  }

  handleSuspense() {
    const { component, suspender } = this;

    const isSuspenseList = component instanceof SuspenseList;

    if (isSuspenseList) {
      this.handleSuspenseList();
    } else {
      Promise.resolve(suspender).then((data) => {
        // console.log(data);
        this.resolve(suspender);
      });
    }
  }

  handleSuspenseList() {
    const { component, childManagers } = this;
    const { revealOrder = 'together', tail } = component;

    /**
     *  set show fallback of all child managers based on tail prop
     *  by default all fallbacks will be shown.
     *  In collapsed mode only one unresolved suspense's fallback will be shown
     *
     *  Also, create a child resolver array
     */
    let showFallback = tail !== 'hidden';

    childManagers.forEach((manager) => {
      if (tail === 'collapsed' && !manager.resolved) {
        showFallback = false;
      }

      manager.showFallback = showFallback;
    });

    /**
     * get binded resolvers for child managers,
     * so manager know, with which suspender its resolved
     */
    const getChildResolver = (manager, suspender) => manager.resolve.bind(manager, suspender);

    // resolve the child managers based on reveal order
    const handleManagerInOrder = (promise, manager) => {
      const { suspender } = manager;
      const resolver = getChildResolver(manager, suspender);
      /**
       * get binded resolvers for child managers,
       * so manager know, with which suspender its resolved
       */

      return promise.then(() => {
        return suspender.then(() => {
          resolver();
        });
      });
    };

    /**
     * If reveal order is together we resolve all the manager only
     * when all the suspenders are resolved.
     *
     * In case of forwards and backwards the managers need to resolved
     * in the provided order event the promise resolves concurrently
     */
    if (revealOrder === 'together') {
      const suspenders = childManagers.map((manager) => manager.suspender);
      Promise.all(suspenders).then(() => {
        childManagers.forEach((manager, index) => {
          const resolver = getChildResolver(manager, suspenders[index]);
          resolver();
        });
      });
    } else if (revealOrder === 'forwards') {
      let promise = Promise.resolve();
      for (let i = 0, ln = childManagers.length; i < ln; i++) {
        promise = handleManagerInOrder(promise, childManagers[i]);
      }
    } else if (revealOrder === 'backwards') {
      let promise = Promise.resolve();
      for (let i = childManagers.length - 1; i >= 0; i--) {
        promise = handleManagerInOrder(promise, childManagers[i]);
      }
    }
  }
}

export class SuspenseManager {
  constructor(component, transition) {
    this.component = component;
    this.transition = transition;
    this.suspender = null;
    this.showFallback = true;
  }

  suspend(suspender) {
    this.suspender = suspender;
    // console.log('suspended times', suspender);
    // TODO: If there is suspense we should wait for the render cycle to finish and then only resolve.
    suspender.then(this.resolve.bind(this, suspender));
  }

  resolve = (resolvedWithSuspender, data) => {
    const { component, transition, suspender } = this;

    // console.log(resolvedWithSuspender, suspender, resolvedWithSuspender === suspender);

    if (resolvedWithSuspender !== suspender) return;

    // mark the suspense to be resolved and component as dirty
    this.suspender = null;
    component[BRAHMOS_DATA_KEY].isDirty = true;

    const transitionTimedOut = transition.transitionState === TRANSITION_STATE_TIMED_OUT;

    // set transition state as resolved if transition is not timed out
    if (!transitionTimedOut) {
      transition.transitionState = TRANSITION_STATE_RESOLVED;
    }
    /**
     * If the transition is timed out or the suspense is not part of
     * the transition pendingSuspense list we need to do normal deferred rendering
     * Otherwise do re-render with the transition.
     */
    console.log(
      'before rerender',
      transition,
      transitionTimedOut || !transition.pendingSuspense.includes(component),
    );
    if (transitionTimedOut || !transition.pendingSuspense.includes(component)) {
      deferredUpdates(() => reRender(component));
    } else {
      withTransition(transition, () => reRender(component));
    }
  };
}

export class SuspenseList extends Component {
  render() {
    return this.props.children;
  }
}

export class Suspense extends Component {
  constructor(props) {
    super(props);
    this.suspenseManagers = {};
  }

  getActiveTransition() {
    const fiber = getFiberFromComponent(this);
    let transition = getTransitionFromFiber(fiber);

    /**
     * If the transition is resolved and pendingSuspense does not include the instance
     * then use the predefined deferred transition as transition
     */
    if (
      transition.transitionState === TRANSITION_STATE_RESOLVED &&
      !transition.pendingSuspense.includes(this)
    ) {
      transition = PREDEFINED_TRANSITION_DEFERRED;
    }

    return transition;
  }

  handleSuspender(suspender) {
    const transition = this.getActiveTransition();

    const suspenseManager = getSuspenseManager(this, transition);

    // console.log(
    //   '++++++++++++',
    //   transition.transitionState,
    //   suspender,
    //   this.props.fallback.template.strings,
    // );

    /**
     * Mark current transition as suspended
     * only if transition is not completed or timed out.
     */
    if (!isTransitionCompleted(transition)) {
      /**
       * Add current suspense to pending suspense
       */
      if (!transition.pendingSuspense.includes(this)) {
        transition.pendingSuspense.push(this);
      }

      // Mark the transition as suspended
      transition.transitionState = TRANSITION_STATE_SUSPENDED;
    }

    suspenseManager.suspend(suspender);
  }

  render() {
    const transition = this.getActiveTransition();
    // console.log('render', transition);

    const { suspender, showFallback } = getSuspenseManager(this, transition);
    const resolved = !suspender;
    const { fallback, children } = this.props;

    // console.log(
    //   'inside render',
    //   fallback.template.strings,
    //   transition.transitionState,
    //   suspender,
    //   showFallback,
    //   Date.now(),
    // );
    if (resolved) return children;
    else if (showFallback) return fallback;
    else return null;
  }
}

export const lazy = (lazyCallback) => {
  let componentPromise;

  const LazyComponent = forwardRef((props, ref) => {
    const Component = getPromiseSuspendedValue(componentPromise).read();
    return createElement(Component, { ...props, ref: ref }, props.children);
  });

  // assign a method to lazy load to start loading during createElement call
  LazyComponent.__loadLazyComponent = () => {
    if (!componentPromise) componentPromise = lazyCallback();
  };

  return LazyComponent;
};
