/* eslint-disable indent */
import {API, Characteristic, DynamicPlatformPlugin, Logger, PlatformAccessory, PlatformConfig, Service} from 'homebridge';
import {isIPv4} from 'net';

import {ConnectorAccessory} from './connectorAccessory';
import {DeviceType, GetDeviceListAck} from './connectorhub/connector-hub-api';
import * as consts from './connectorhub/connector-hub-constants';
import {ExtendedDeviceInfo} from './connectorhub/connector-hub-helpers';
import {ConnectorHubClient} from './connectorhub/connectorHubClient';
import {PLATFORM_NAME, PLUGIN_NAME} from './settings';
import {Log} from './util/log';

// How long we wait after a failed discovery attempt before retrying.
const kDiscoveryRefreshInterval = 5000;

/**
 * This class is the entry point for the plugin. It is responsible for parsing
 * the user config, discovering accessories, and registering them.
 */
export class ConnectorHubPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service = this.api.hap.Service;
  public readonly Characteristic: typeof Characteristic =
      this.api.hap.Characteristic;

  // This array is used to track restored cached accessories.
  private readonly cachedAccessories: PlatformAccessory[] = [];

  // This array records the handlers which wrap each accessory.
  private readonly accessoryHandlers: ConnectorAccessory[] = [];

  // This array records which hubs have been scanned for devices.
  private readonly scannedHubs: string[] = [];

  constructor(
      private readonly logger: Logger,
      public readonly config: PlatformConfig,
      public readonly api: API,
  ) {
    // Configure the custom log with the Homebridge logger and debug config.
    Log.configure(logger, config.enableDebugLog);

    // If the config is not valid, bail out immediately. We will not discover
    // any new accessories or register any handlers for cached accessories.
    const validationErrors = this.validateConfig(config);
    if (validationErrors.length > 0) {
      Log.error('Plugin suspended. Invalid configuration:', validationErrors);
      return;
    }

    // Notify the user that we have completed platform initialization.
    Log.debug('Finished initializing platform');

    // This event is fired when Homebridge has restored all cached accessories.
    // We must add handlers for these, and check for any new accessories.
    this.api.on('didFinishLaunching', () => {
      Log.debug('Finished restoring all cached accessories from disk');
      this.discoverDevices();
    });
  }

  // Validate that the plugin configuration conforms to the expected format.
  private validateConfig(config: PlatformConfig): string[] {
    const validationErrors: string[] = [];
    if (!config.connectorKey) {
      validationErrors.push('App Key has not been configured');
    }
    config.hubIps = (config.hubIps || []);
    const invalidIps = config.hubIps.filter((ip: string) => !isIPv4(ip));
    for (const invalidIp of invalidIps) {
      validationErrors.push(`Hub IP is not valid IPv4: ${invalidIp}`);
    }
    return validationErrors;
  }

  /**
   * This function is invoked for each cached accessory that homebridge restores
   * from disk at startup. Here we add the cached accessories to a list which
   * will be examined later during the 'discoverDevices' phase.
   */
  public configureAccessory(accessory: PlatformAccessory) {
    Log.info('Loading accessory from cache:', accessory.displayName);
    this.cachedAccessories.push(accessory);
  }

  /**
   * Iterate over the given hub IPs and begin the discovery process for each.
   * Note that we use the term "hub" here to distinguish them from individual
   * devices, but in practice a device may be its own hub if, for instance, it
   * is a WiFi motor device.
   */
  private async discoverDevices() {
    if (this.config.hubIps.length === 0) {
      Log.info('No device IPs configured, defaulting to multicast discovery');
      this.config.hubIps.push(consts.kMulticastIp);
    }
    for (const hubIp of this.config.hubIps) {
      this.scanHubOrWifiDevice(hubIp);
    }
    // Don't proactively remove stale accessories. There is a possibility that
    // we could fail to discover all devices in time, and this would cause us to
    // remove devices that are still active.
    // this.removeStaleAccessories();
  }

  /**
   * Discover and register accessories. Accessories must only be registered
   * once; previously created accessories must not be registered again, to
   * avoid "duplicate UUID" errors.
   */
  private async scanHubOrWifiDevice(hubIp: string) {
    // Discover accessories from the local network. If we fail to discover
    // anything, schedule another discovery attempt in the future.
    const responses =
        <GetDeviceListAck[]>(await ConnectorHubClient.getDeviceList(hubIp));

    if (!responses || responses.length === 0) {
      Log.warn(
          `Failed to reach ${hubIp}, retry in ${kDiscoveryRefreshInterval}ms`);
      setTimeout(
          () => this.scanHubOrWifiDevice(hubIp), kDiscoveryRefreshInterval);
      return responses;
    }

    // For each of the possibly multiple responses received...
    for (const response of responses) {
      // ... output the list of discovered devices in debug mode...
      Log.debug('Discovered devices:', response);

      // ... and iterate over the discovered devices, registering each of them.
      for (const discoveredDevice of response.data) {
        // If this entry is the hub itself, skip over it and continue.
        if (discoveredDevice.deviceType === DeviceType.kWiFiBridge) {
          continue;
        }
        // Augment the basic device information with additional details.
        const deviceInfo: ExtendedDeviceInfo =
            Object.assign({fwVersion: response.fwVersion}, discoveredDevice);

        // Generate a unique id for the accessory from its MAC address.
        const defaultDisplayName = `Connector Device ${deviceInfo.mac}`;
        const uuid = this.api.hap.uuid.generate(deviceInfo.mac);

        // See if an accessory with the same uuid already exists.
        let accessory =
            this.cachedAccessories.find(accessory => accessory.UUID === uuid);

        // If the accessory does not yet exist, we need to create it.
        if (!accessory) {
          Log.info('Adding new accessory:', defaultDisplayName);
          accessory = new this.api.platformAccessory(defaultDisplayName, uuid);
          this.api.registerPlatformAccessories(
              PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        } else {
          // Remove the cached accessory from the list before adding a handler.
          this.cachedAccessories.splice(
              this.cachedAccessories.indexOf(accessory), 1);
        }

        // Make sure the accessory stays in sync with any device config changes.
        accessory.context.device = deviceInfo;
        this.api.updatePlatformAccessories([accessory]);

        // Create the accessory handler for this accessory.
        Log.debug('Creating handler for accessory:', defaultDisplayName);
        this.accessoryHandlers.push(
            new ConnectorAccessory(this, accessory, hubIp, response.token));
      }
    }

    // Record that we have successfully scanned this hub for devices.
    this.scannedHubs.push(hubIp);
  }

  private async removeStaleAccessories() {
    // We don't know which accessories are stale until we have scanned all hubs.
    if (this.scannedHubs.length !== this.config.hubIps.length) {
      setTimeout(
          () => this.removeStaleAccessories(), kDiscoveryRefreshInterval);
      return;
    }
    // Any cached accessories that remain in the cachedAccessories list are
    // stale and no longer exist on any hubs. Remove them from Homekit.
    let removedAccessory: PlatformAccessory|undefined;
    while ((removedAccessory = this.cachedAccessories.pop())) {
      Log.info('Removing stale accessory:', removedAccessory.displayName);
      this.api.unregisterPlatformAccessories(
          PLUGIN_NAME, PLATFORM_NAME, [removedAccessory]);
    }
    Log.debug('Finished looking for stale accessories to remove');
  }
}
