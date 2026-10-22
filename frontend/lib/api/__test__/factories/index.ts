import { faker } from "@faker-js/faker";
import { expect } from "vitest";
import { overrideParts } from "../../base/urls";
import { PublicApi } from "../../public";
import type {
  EntityFieldData,
  EntityOut,
  EntityUpdate,
  EntityTemplateCreate,
  TagCreate,
  EntityCreate,
  UserRegistration,
} from "../../types/data-contracts";
import * as config from "../../../../test/config";
import { UserClient } from "../../user";
import { Requests } from "../../../requests";

function itemField(id = "00000000-0000-0000-0000-000000000000"): EntityFieldData {
  return {
    id,
    name: faker.lorem.word(),
    type: "text",
    textValue: faker.lorem.sentence(),
    booleanValue: false,
    numberValue: faker.number.int(),
  };
}

/**
 * Returns a random user registration object that can be
 * used to signup a new user.
 */
function user(): UserRegistration {
  return {
    email: faker.internet.email(),
    password: faker.internet.password(),
    name: faker.person.firstName(),
    token: "",
  };
}

async function entityTypeId(api: UserClient, isLocation = false): Promise<string> {
  const { response, data } = await api.entityTypes.getAll();
  expect(response.status).toBe(200);
  const entityType = data.find(type => type.isLocation === isLocation);
  if (!entityType) {
    throw new Error(`Expected a ${isLocation ? "location" : "item"} entity type`);
  }
  return entityType.id;
}

async function location(api: UserClient, parentId: string | null = null): Promise<EntityCreate> {
  return {
    parentId,
    name: faker.location.city(),
    description: faker.lorem.sentence(),
    entityTypeId: await entityTypeId(api, true),
    quantity: 1,
    tagIds: [],
  };
}

function itemUpdate(item: EntityOut): EntityUpdate {
  if (!item.entityType) {
    throw new Error("Expected the item's entity type");
  }
  return {
    ...item,
    entityTypeId: item.entityType.id,
    parentId: item.parent?.id ?? null,
    tagIds: item.tags.map(tag => tag.id),
  };
}

function tag(): TagCreate {
  return {
    name: faker.lorem.word(),
    description: faker.lorem.sentence(),
    color: faker.color.rgb(),
    icon: "",
  };
}

function template(): EntityTemplateCreate {
  return {
    name: faker.lorem.words(2),
    description: faker.lorem.sentence(),
    notes: "",
    defaultQuantity: 1,
    defaultInsured: false,
    defaultName: faker.lorem.word(),
    defaultDescription: faker.lorem.sentence(),
    defaultManufacturer: faker.company.name(),
    defaultModelNumber: faker.string.alphanumeric(10),
    defaultLifetimeWarranty: false,
    defaultWarrantyDetails: "",
    defaultLocationId: null,
    defaultTagIds: null,
    includeWarrantyFields: false,
    includePurchaseFields: false,
    includeSoldFields: false,
    fields: [],
  };
}

function publicClient(): PublicApi {
  overrideParts(config.BASE_URL, "/api/v1");
  const requests = new Requests("");
  return new PublicApi(requests);
}

function userClient(token: string): UserClient {
  overrideParts(config.BASE_URL, "/api/v1");
  const requests = new Requests("", token);
  return new UserClient(requests, "");
}

type TestUser = {
  client: UserClient;
  user: UserRegistration;
};

async function userSingleUse(): Promise<TestUser> {
  const usr = user();

  const pub = publicClient();
  await pub.register(usr);
  const result = await pub.login(usr.email, usr.password);

  expect(result.error).toBeFalsy();
  expect(result.status).toBe(200);

  return {
    client: new UserClient(new Requests("", result.data.token), result.data.attachmentToken),
    user: usr,
  };
}

export const factories = {
  user,
  location,
  entityTypeId,
  itemUpdate,
  tag,
  template,
  itemField,
  client: {
    public: publicClient,
    user: userClient,
    singleUse: userSingleUse,
  },
};
