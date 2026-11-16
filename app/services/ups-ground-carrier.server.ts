import type { authenticate } from "../shopify.server";
import { UPS_GROUND_STATES } from "./ups-ground-rate.server";

type Admin = Awaited<ReturnType<typeof authenticate.admin>>["admin"];

// The app's own carrier service (app/routes/carrier.ups-ground.tsx). It is
// only ever added to shipping zones that cover nothing but Alaska and/or
// Hawaii, so no other zone's rates change.
export const CARRIER_NAME = "Zion UPS Ground (Alaska & Hawaii)";

type Zone = {
  profileId: string;
  profileName: string;
  locationGroupId: string;
  zoneId: string;
  zoneName: string;
  hasCarrier: boolean;
};

async function gql<T = any>(admin: Admin, query: string, variables?: Record<string, unknown>): Promise<T> {
  const response = await admin.graphql(query, variables ? { variables } : undefined);
  const json = await response.json();
  return json.data as T;
}

async function findCarrier(admin: Admin) {
  const data = await gql(admin, `#graphql
    query ZionCarrierServices { carrierServices(first: 50) { nodes { id name active callbackUrl } } }
  `);
  return ((data?.carrierServices?.nodes ?? []) as Array<{ id: string; name: string; active: boolean; callbackUrl: string }>)
    .find((node) => node.name === CARRIER_NAME) ?? null;
}

/** Zones whose only country is the US and whose states are all AK/HI. */
async function alaskaHawaiiZones(admin: Admin, carrierId?: string): Promise<Zone[]> {
  const data = await gql(admin, `#graphql
    query AlaskaHawaiiZones {
      deliveryProfiles(first: 50) {
        nodes {
          id
          name
          profileLocationGroups {
            locationGroup { id }
            locationGroupZones(first: 50) {
              nodes {
                zone { id name countries { code { countryCode restOfWorld } provinces { code } } }
                methodDefinitions(first: 50) {
                  nodes { rateProvider { ... on DeliveryParticipant { carrierService { id } } } }
                }
              }
            }
          }
        }
      }
    }
  `);
  const zones: Zone[] = [];
  for (const profile of data?.deliveryProfiles?.nodes ?? []) {
    for (const group of profile.profileLocationGroups ?? []) {
      for (const node of group.locationGroupZones?.nodes ?? []) {
        const countries = node.zone.countries ?? [];
        const onlyUs = countries.length === 1 && countries[0].code?.countryCode === "US" && !countries[0].code?.restOfWorld;
        const provinces: string[] = (countries[0]?.provinces ?? []).map((province: { code: string }) => province.code);
        const onlyAkHi = provinces.length > 0 && provinces.every((code) => UPS_GROUND_STATES.includes(code));
        if (!onlyUs || !onlyAkHi) continue;
        zones.push({
          profileId: profile.id,
          profileName: profile.name,
          locationGroupId: group.locationGroup.id,
          zoneId: node.zone.id,
          zoneName: node.zone.name,
          hasCarrier: Boolean(carrierId) && (node.methodDefinitions?.nodes ?? [])
            .some((method: any) => method.rateProvider?.carrierService?.id === carrierId),
        });
      }
    }
  }
  return zones;
}

export async function upsGroundCarrierStatus(admin: Admin) {
  const carrier = await findCarrier(admin);
  const zones = await alaskaHawaiiZones(admin, carrier?.id);
  return {
    active: Boolean(carrier?.active),
    zones: zones.filter((zone) => zone.hasCarrier).map((zone) => `${zone.zoneName} (${zone.profileName})`),
  };
}

/** Turns the app's UPS Ground rate on or off. Returns an error message on failure. */
export async function setUpsGroundCarrier(admin: Admin, active: boolean): Promise<string | null> {
  const callbackUrl = `${process.env.SHOPIFY_APP_URL}/carrier/ups-ground`;
  let carrier = await findCarrier(admin);

  if (!carrier && !active) return null;

  if (!carrier) {
    const data = await gql(admin, `#graphql
      mutation CreateZionCarrier($input: DeliveryCarrierServiceCreateInput!) {
        carrierServiceCreate(input: $input) {
          carrierService { id name active callbackUrl }
          userErrors { message }
        }
      }
    `, { input: { name: CARRIER_NAME, callbackUrl, active: true, supportsServiceDiscovery: false } });
    carrier = data?.carrierServiceCreate?.carrierService ?? null;
    if (!carrier) return data?.carrierServiceCreate?.userErrors?.[0]?.message || "The UPS Ground rate could not be set up.";
  } else if (carrier.active !== active || carrier.callbackUrl !== callbackUrl) {
    const data = await gql(admin, `#graphql
      mutation UpdateZionCarrier($input: DeliveryCarrierServiceUpdateInput!) {
        carrierServiceUpdate(input: $input) {
          carrierService { id }
          userErrors { message }
        }
      }
    `, { input: { id: carrier.id, active, callbackUrl } });
    if (!data?.carrierServiceUpdate?.carrierService) {
      return data?.carrierServiceUpdate?.userErrors?.[0]?.message || "The UPS Ground rate could not be updated.";
    }
  }

  if (!active) return null;

  const missing = (await alaskaHawaiiZones(admin, carrier.id)).filter((zone) => !zone.hasCarrier);
  for (const zone of missing) {
    const data = await gql(admin, `#graphql
      mutation AddZionCarrierToZone($id: ID!, $profile: DeliveryProfileInput!) {
        deliveryProfileUpdate(id: $id, profile: $profile) {
          profile { id }
          userErrors { message }
        }
      }
    `, {
      id: zone.profileId,
      profile: {
        locationGroupsToUpdate: [{
          id: zone.locationGroupId,
          zonesToUpdate: [{
            id: zone.zoneId,
            methodDefinitionsToCreate: [{
              active: true,
              participant: { carrierServiceId: carrier.id, adaptToNewServices: true },
            }],
          }],
        }],
      },
    });
    const error = data?.deliveryProfileUpdate?.userErrors?.[0]?.message;
    if (error || !data?.deliveryProfileUpdate?.profile) {
      return `Could not add the UPS Ground rate to "${zone.zoneName}": ${error || "unknown error"}`;
    }
  }
  return null;
}
