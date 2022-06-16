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

import { Disposable } from './types/disposable';
import type * as containerDesktopAPI from '@tmpwip/extension-api';
import { Emitter } from './events/emitter';
import type * as Dockerode from 'dockerode';
import type { Telemetry } from './telemetry/telemetry';
import * as crypto from 'node:crypto';

export class ImageRegistry {
  private registries: containerDesktopAPI.Registry[] = [];
  private providers: Map<string, containerDesktopAPI.RegistryProvider> = new Map();

  private readonly _onDidRegisterRegistry = new Emitter<containerDesktopAPI.Registry>();
  private readonly _onDidUpdateRegistry = new Emitter<containerDesktopAPI.Registry>();
  private readonly _onDidUnregisterRegistry = new Emitter<containerDesktopAPI.Registry>();

  readonly onDidRegisterRegistry: containerDesktopAPI.Event<containerDesktopAPI.Registry> =
    this._onDidRegisterRegistry.event;
  readonly onDidUpdateRegistry: containerDesktopAPI.Event<containerDesktopAPI.Registry> =
    this._onDidUpdateRegistry.event;
  readonly onDidUnregisterRegistry: containerDesktopAPI.Event<containerDesktopAPI.Registry> =
    this._onDidUnregisterRegistry.event;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(private apiSender: any, private telemetryService: Telemetry) {}

  getAuthconfigForImage(imageName: string): Dockerode.AuthConfig | undefined {
    // do we have some auth for this image
    // try to extract registry part from the image

    // no / in the imageName
    let registryServer: string | undefined;
    if (imageName.indexOf('/') === -1 || imageName.split('/').length == 2) {
      registryServer = 'docker.io';
    } else if (imageName.split('/').length == 3) {
      // if image name contains two /, we assume there is a registry at the beginning
      registryServer = imageName.split('/')[0];
    }
    let authconfig;
    if (registryServer) {
      const matchingUrl = registryServer;
      // grab authentication data for this server
      const matchingRegistry = this.getRegistries().find(
        registry => registry.serverUrl.toLowerCase() === matchingUrl.toLowerCase(),
      );
      if (matchingRegistry) {
        let serveraddress = matchingRegistry.serverUrl.toLowerCase();
        if (serveraddress === 'docker.io') {
          serveraddress = 'https://index.docker.io/v2/';
        }
        authconfig = {
          username: matchingRegistry.username,
          password: matchingRegistry.secret,
          serveraddress,
        };
      }
    }
    return authconfig;
  }

  getRegistryHash(registry: { serverUrl: string }): string {
    return crypto.createHash('sha512').update(registry.serverUrl).digest('hex');
  }

  registerRegistry(registry: containerDesktopAPI.Registry): Disposable {
    this.registries = [...this.registries, registry];
    this.telemetryService.track('registerRegistry', {
      serverUrl: this.getRegistryHash(registry),
      total: this.registries.length,
    });
    this.apiSender.send('registry-register', registry);
    this._onDidRegisterRegistry.fire(Object.freeze({ ...registry }));
    return Disposable.create(() => {
      this.unregisterRegistry(registry);
    });
  }

  unregisterRegistry(registry: containerDesktopAPI.Registry): void {
    const filtered = this.registries.filter(
      registryItem => registryItem.serverUrl !== registry.serverUrl || registry.source !== registryItem.source,
    );
    if (filtered.length !== this.registries.length) {
      this._onDidUnregisterRegistry.fire(Object.freeze({ ...registry }));
      this.registries = filtered;
      this.apiSender.send('registry-unregister', registry);
    }
    this.telemetryService.track('unregisterRegistry', {
      serverUrl: this.getRegistryHash(registry),
      total: this.registries.length,
    });
  }

  getRegistries(): readonly containerDesktopAPI.Registry[] {
    return this.registries;
  }

  getProviderNames(): string[] {
    return Array.from(this.providers.keys());
  }

  registerRegistryProvider(registerRegistryProvider: containerDesktopAPI.RegistryProvider): Disposable {
    this.providers.set(registerRegistryProvider.name, registerRegistryProvider);
    return Disposable.create(() => {
      this.providers.delete(registerRegistryProvider.name);
    });
  }

  createRegistry(providerName: string, registryCreateOptions: containerDesktopAPI.RegistryCreateOptions): Disposable {
    const provider = this.providers.get(providerName);
    if (!provider) {
      throw new Error(`Provider ${providerName} not found`);
    }

    const exists = this.registries.find(
      registry => registry.serverUrl === registryCreateOptions.serverUrl && registry.source === providerName,
    );
    if (exists) {
      throw new Error(`Registry ${registryCreateOptions.serverUrl} already exists`);
    }
    const registry = provider.create(registryCreateOptions);
    this.telemetryService.track('createRegistry', {
      serverUrlHash: this.getRegistryHash(registryCreateOptions),
      total: this.registries.length,
    });
    return this.registerRegistry(registry);
  }

  updateRegistry(registryUrl: string, registry: containerDesktopAPI.Registry): void {
    const matchingRegistry = this.registries.find(
      existringRegistry => registry.serverUrl === registry.serverUrl && registry.source === existringRegistry.source,
    );
    if (!matchingRegistry) {
      throw new Error(`Registry ${registryUrl} was not found`);
    }
    matchingRegistry.username = registry.username;
    matchingRegistry.secret = registry.secret;
    this.telemetryService.track('updateRegistry', {
      serverUrl: this.getRegistryHash(matchingRegistry),
      total: this.registries.length,
    });
    this.apiSender.send('registry-update', registry);
    this._onDidUpdateRegistry.fire(Object.freeze(registry));
  }
}
