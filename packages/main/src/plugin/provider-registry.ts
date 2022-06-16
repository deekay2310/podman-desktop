/**********************************************************************
 * Copyright (C) 2022 Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 ***********************************************************************/

import type {
  ContainerProviderConnection,
  Provider,
  ProviderLifecycle,
  ProviderOptions,
  ProviderStatus,
} from '@tmpwip/extension-api';
import type {
  ProviderContainerConnectionInfo,
  ProviderInfo,
  ProviderKubernetesConnectionInfo,
  LifecycleMethod,
} from './api/provider-info';
import type { ContainerProviderRegistry } from './container-registry';
import { LifecycleContextImpl } from './lifecycle-context';
import { ProviderImpl } from './provider-impl';
import type { Telemetry } from './telemetry/telemetry';
import { Disposable } from './types/disposable';

export type ProviderEventListener = (name: string, providerInfo: ProviderInfo) => void;
export type ProviderLifecycleListener = (
  name: string,
  providerInfo: ProviderInfo,
  lifecycle: ProviderLifecycle,
) => void;
export type ContainerConnectionProviderLifecycleListener = (
  name: string,
  providerInfo: ProviderInfo,
  providerContainerConnectionInfo: ProviderContainerConnectionInfo,
) => void;

/**
 * Manage creation of providers and their lifecycle.
 * subscribe to events to get notified about provider creation and lifecycle changes.
 */
export class ProviderRegistry {
  private count = 0;
  private providers: Map<string, ProviderImpl>;
  private providerStatuses = new Map<string, ProviderStatus>();

  private providerLifecycles: Map<string, ProviderLifecycle> = new Map();
  private providerLifecycleContexts: Map<string, LifecycleContextImpl> = new Map();
  private connectionLifecycleContexts: Map<ContainerProviderConnection, LifecycleContextImpl> = new Map();
  private listeners: ProviderEventListener[];
  private lifecycleListeners: ProviderLifecycleListener[];
  private containerConnectionLifecycleListeners: ContainerConnectionProviderLifecycleListener[];

  constructor(private containerRegistry: ContainerProviderRegistry, private telemetryService: Telemetry) {
    this.providers = new Map();
    this.listeners = [];
    this.lifecycleListeners = [];
    this.containerConnectionLifecycleListeners = [];

    setInterval(async () => {
      Array.from(this.providers.keys()).forEach(providerKey => {
        const provider = this.providers.get(providerKey);
        const providerLifecycle = this.providerLifecycles.get(providerKey);
        if (provider && providerLifecycle) {
          const status = providerLifecycle.status();
          if (status !== this.providerStatuses.get(providerKey)) {
            provider.setStatus(status);
            this.listeners.forEach(listener => listener('provider:update-status', this.getProviderInfo(provider)));
            this.providerStatuses.set(providerKey, status);
          }
        }
      });
    }, 2000);
  }

  createProvider(providerOptions: ProviderOptions): Provider {
    const id = `${this.count}`;
    const providerImpl = new ProviderImpl(id, providerOptions, this, this.containerRegistry);
    this.count++;
    this.providers.set(id, providerImpl);
    this.listeners.forEach(listener => listener('provider:create', this.getProviderInfo(providerImpl)));
    return providerImpl;
  }

  disposeProvider(providerImpl: ProviderImpl): void {
    this.providers.delete(providerImpl.internalId);
    this.listeners.forEach(listener => listener('provider:delete', this.getProviderInfo(providerImpl)));
  }

  // need to call dispose() method to unregister the lifecycle
  registerLifecycle(providerImpl: ProviderImpl, lifecycle: ProviderLifecycle): Disposable {
    this.providerLifecycles.set(providerImpl.internalId, lifecycle);
    this.providerLifecycleContexts.set(providerImpl.internalId, new LifecycleContextImpl());

    this.lifecycleListeners.forEach(listener =>
      listener('provider:register-lifecycle', this.getProviderInfo(providerImpl), lifecycle),
    );

    return Disposable.create(() => {
      this.providerLifecycles.delete(providerImpl.internalId);
      this.providerLifecycleContexts.delete(providerImpl.internalId);
      this.lifecycleListeners.forEach(listener =>
        listener('provider:removal-lifecycle', this.getProviderInfo(providerImpl), lifecycle),
      );
    });
  }

  getProviderLifecycle(providerInternalId: string): ProviderLifecycle | undefined {
    return this.providerLifecycles.get(providerInternalId);
  }

  addProviderListener(listener: ProviderEventListener): void {
    this.listeners.push(listener);
  }

  removeProviderListener(listener: ProviderEventListener): void {
    const index = this.listeners.indexOf(listener);
    if (index !== -1) {
      this.listeners.splice(index, 1);
    }
  }

  addProviderLifecycleListener(listener: ProviderLifecycleListener): void {
    this.lifecycleListeners.push(listener);
  }

  removeProviderLifecycleListener(listener: ProviderLifecycleListener): void {
    const index = this.lifecycleListeners.indexOf(listener);
    if (index !== -1) {
      this.lifecycleListeners.splice(index, 1);
    }
  }

  addProviderContainerConnectionLifecycleListener(listener: ContainerConnectionProviderLifecycleListener): void {
    this.containerConnectionLifecycleListeners.push(listener);
  }

  removeProviderContainerConnectionLifecycleListener(listener: ContainerConnectionProviderLifecycleListener): void {
    const index = this.containerConnectionLifecycleListeners.indexOf(listener);
    if (index !== -1) {
      this.lifecycleListeners.splice(index, 1);
    }
  }

  async startProviderLifecycle(providerId: string): Promise<void> {
    const provider = this.getMatchingProvider(providerId);
    const providerLifecycle = this.getMatchingProviderLifecycle(providerId);
    const context = this.getMatchingLifecycleContext(providerId);

    this.lifecycleListeners.forEach(listener =>
      listener('provider:before-start-lifecycle', this.getProviderInfo(provider), providerLifecycle),
    );

    await providerLifecycle.start(context);
    this.lifecycleListeners.forEach(listener =>
      listener('provider:after-start-lifecycle', this.getProviderInfo(provider), providerLifecycle),
    );
  }

  async stopProviderLifecycle(providerId: string): Promise<void> {
    const provider = this.getMatchingProvider(providerId);
    const providerLifecycle = this.getMatchingProviderLifecycle(providerId);
    const context = this.getMatchingLifecycleContext(providerId);

    this.lifecycleListeners.forEach(listener =>
      listener('provider:before-stop-lifecycle', this.getProviderInfo(provider), providerLifecycle),
    );
    await providerLifecycle.stop(context);
    this.lifecycleListeners.forEach(listener =>
      listener('provider:after-stop-lifecycle', this.getProviderInfo(provider), providerLifecycle),
    );
  }

  public getProviderContainerConnectionInfo(connection: ContainerProviderConnection): ProviderContainerConnectionInfo {
    const containerProviderConnection: ProviderContainerConnectionInfo = {
      name: connection.name,
      status: connection.status(),
      endpoint: {
        socketPath: connection.endpoint.socketPath,
      },
    };
    if (connection.lifecycle) {
      const lifecycleMethods: LifecycleMethod[] = [];
      if (connection.lifecycle.delete) {
        lifecycleMethods.push('delete');
      }
      if (connection.lifecycle.start) {
        lifecycleMethods.push('start');
      }
      if (connection.lifecycle.stop) {
        lifecycleMethods.push('stop');
      }
      containerProviderConnection.lifecycleMethods = lifecycleMethods;
    }
    return containerProviderConnection;
  }

  protected getProviderInfo(provider: ProviderImpl): ProviderInfo {
    const containerConnections: ProviderContainerConnectionInfo[] = provider.containerConnections.map(connection => {
      return this.getProviderContainerConnectionInfo(connection);
    });
    const kubernetesConnections: ProviderKubernetesConnectionInfo[] = provider.kubernetesConnections.map(connection => {
      return {
        name: connection.name,
        status: connection.status(),
        endpoint: {
          apiURL: connection.endpoint.apiURL,
        },
      };
    });

    // container connection factory ?
    let containerProviderConnectionCreation = false;
    if (provider.containerProviderConnectionFactory) {
      containerProviderConnectionCreation = true;
    }

    const providerInfo: ProviderInfo = {
      id: provider.id,
      internalId: provider.internalId,
      name: provider.name,
      containerConnections,
      kubernetesConnections,
      status: provider.status,
      containerProviderConnectionCreation,
    };

    // lifecycle ?
    if (this.providerLifecycles.has(provider.internalId)) {
      providerInfo.lifecycleMethods = ['start', 'stop'];
    }
    return providerInfo;
  }

  getProviderInfos(): ProviderInfo[] {
    return Array.from(this.providers.values()).map(provider => {
      return this.getProviderInfo(provider);
    });
  }

  // helper method
  protected getMatchingProviderLifecycle(providerId: string): ProviderLifecycle {
    // need to find the provider lifecycle
    const providerLifecycle = this.providerLifecycles.get(providerId);
    if (!providerLifecycle) {
      throw new Error(`no provider lifecycle matching provider id ${providerId}`);
    }
    return providerLifecycle;
  }

  // helper method
  protected getMatchingProvider(providerId: string): ProviderImpl {
    // need to find the provider
    const provider = this.providers.get(providerId);
    if (!provider) {
      throw new Error(`no provider matching provider id ${providerId}`);
    }
    return provider;
  }

  getMatchingLifecycleContext(providerId: string): LifecycleContextImpl {
    const context = this.providerLifecycleContexts.get(providerId);
    if (!context) {
      throw new Error(`no lifecycle context matching provider id ${providerId}`);
    }

    return context;
  }

  getMatchingContainerLifecycleContext(
    providerId: string,
    providerContainerConnectionInfo: ProviderContainerConnectionInfo,
  ): LifecycleContextImpl {
    const connection = this.getMatchingContainerConnectionFromProvider(providerId, providerContainerConnectionInfo);

    const context = this.connectionLifecycleContexts.get(connection);
    if (!context) {
      throw new Error('The connection does not have context to start');
    }

    return context;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async createProviderConnection(internalProviderId: string, params: { [key: string]: any }): Promise<void> {
    // grab the correct provider
    const provider = this.getMatchingProvider(internalProviderId);

    if (!provider.containerProviderConnectionFactory) {
      throw new Error('The provider does not support container connection creation');
    }
    return provider.containerProviderConnectionFactory.create(params);
  }

  // helper method
  protected getMatchingContainerConnectionFromProvider(
    internalProviderId: string,
    providerContainerConnectionInfo: ProviderContainerConnectionInfo,
  ): ContainerProviderConnection {
    // grab the correct provider
    const provider = this.getMatchingProvider(internalProviderId);

    // grab the correct container connection
    const containerConnection = provider.containerConnections.find(
      connection => connection.endpoint.socketPath === providerContainerConnectionInfo.endpoint.socketPath,
    );
    if (!containerConnection) {
      throw new Error(`no container connection matching provider id ${internalProviderId}`);
    }
    return containerConnection;
  }

  async startProviderConnection(
    internalProviderId: string,
    providerContainerConnectionInfo: ProviderContainerConnectionInfo,
  ): Promise<void> {
    // grab the correct provider
    const connection = this.getMatchingContainerConnectionFromProvider(
      internalProviderId,
      providerContainerConnectionInfo,
    );

    const lifecycle = connection.lifecycle;
    if (!lifecycle || !lifecycle.start) {
      throw new Error('The container connection does not support start lifecycle');
    }

    const context = this.connectionLifecycleContexts.get(connection);
    if (!context) {
      throw new Error('The connection does not have context to start');
    }

    return lifecycle.start(context);
  }

  async stopProviderConnection(
    internalProviderId: string,
    providerContainerConnectionInfo: ProviderContainerConnectionInfo,
  ): Promise<void> {
    // grab the correct provider
    const connection = this.getMatchingContainerConnectionFromProvider(
      internalProviderId,
      providerContainerConnectionInfo,
    );

    const lifecycle = connection.lifecycle;
    if (!lifecycle || !lifecycle.stop) {
      throw new Error('The container connection does not support stop lifecycle');
    }

    const context = this.connectionLifecycleContexts.get(connection);
    if (!context) {
      throw new Error('The connection does not have context to start');
    }

    return lifecycle.stop(context);
  }

  async deleteProviderConnection(
    internalProviderId: string,
    providerContainerConnectionInfo: ProviderContainerConnectionInfo,
  ): Promise<void> {
    // grab the correct provider
    const connection = this.getMatchingContainerConnectionFromProvider(
      internalProviderId,
      providerContainerConnectionInfo,
    );

    const lifecycle = connection.lifecycle;
    if (!lifecycle || !lifecycle.delete) {
      throw new Error('The container connection does not support delete lifecycle');
    }
    this.telemetryService.track('deleteProviderConnection', { name: providerContainerConnectionInfo.name });
    return lifecycle.delete();
  }

  onDidRegisterContainerConnection(provider: ProviderImpl, containerProviderConnection: ContainerProviderConnection) {
    this.connectionLifecycleContexts.set(containerProviderConnection, new LifecycleContextImpl());
    // notify listeners
    this.containerConnectionLifecycleListeners.forEach(listener => {
      listener(
        'provider-container-connection:register',
        this.getProviderInfo(provider),
        this.getProviderContainerConnectionInfo(containerProviderConnection),
      );
    });
  }

  onDidChangeContainerProviderConnectionStatus(
    provider: ProviderImpl,
    containerConnection: ContainerProviderConnection,
  ) {
    // notify listeners
    this.containerConnectionLifecycleListeners.forEach(listener => {
      listener(
        'provider-container-connection:update-status',
        this.getProviderInfo(provider),
        this.getProviderContainerConnectionInfo(containerConnection),
      );
    });
  }

  onDidUnregisterContainerConnection(provider: ProviderImpl, containerConnection: ContainerProviderConnection) {
    // notify listeners
    this.containerConnectionLifecycleListeners.forEach(listener => {
      listener(
        'provider-container-connection::unregister',
        this.getProviderInfo(provider),
        this.getProviderContainerConnectionInfo(containerConnection),
      );
    });
  }
}
