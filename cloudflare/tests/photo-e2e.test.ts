import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const EP = "https://example.com/graphql";

async function gql(query: string, variables?: Record<string, unknown>, token?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await SELF.fetch(EP, {
    method: "POST",
    headers,
    body: JSON.stringify({ query, variables }),
  });
  return (await res.json()) as any;
}

describe("full QR-container + image-upload round-trip", () => {
  it("scan(container) -> add item -> upload photo to R2 -> serve -> clearPhoto", async () => {
    // auth
    const login = await gql(
      `mutation($s:CommerceSiteId!,$u:String!,$p:String!){authLogin(siteId:$s,username:$u,password:$p){token}}`,
      { s: "DE", u: "photo@fam.test", p: "pw123456" },
    );
    const token = login.data.authLogin.token as string;
    expect(token.split(".")).toHaveLength(3);

    // 1. "scan" a box: register the container by its QR/NFC id, then read it back
    const CID = "SCAN-QR-BOX-1";
    const save = await gql(
      `mutation{containerSave(containerId:"${CID}",containerType:"FRESHANDSAVE",size:"M",storageType:FRESHANDSAVE,info:{amountOfGrams:250,code:"c1"}){success}}`,
      {},
      token,
    );
    expect(save.data.containerSave.success).toBe(true);
    const cget = await gql(
      `query{containerGet(containerId:"${CID}"){containerId size storageType amountOfGrams}}`,
      {},
      token,
    );
    expect(cget.data.containerGet.containerId).toBe(CID);
    expect(cget.data.containerGet.size).toBe("M");

    // 2. create an inventory item linked to the scanned container
    const fg = (await gql(`query{foodgroupList(bucket:ZWILLING,locale:"en"){cloudId}}`)).data
      .foodgroupList[0].cloudId;
    const created = await gql(
      `mutation($e:String!){freshandsaveCreate(name:"Steak",expire:$e,containerId:"${CID}",foodgroupId:"${fg}",storageplace:FRIDGE){cloudId}}`,
      { e: "2027-01-01T00:00:00.000Z" },
      token,
    );
    const itemId = created.data.freshandsaveCreate.cloudId as string;
    expect(itemId).toBeTruthy();

    // before upload: photo empty, vessel resolves to the NfcContainer
    const before = await gql(
      `query($c:ID!){freshandsave(cloudId:$c){photo{url} vessel{__typename ... on NfcContainer{containerId}}}}`,
      { c: itemId },
      token,
    );
    expect(before.data.freshandsave.photo ?? []).toHaveLength(0);
    expect(before.data.freshandsave.vessel.__typename).toBe("NfcContainer");
    expect(before.data.freshandsave.vessel.containerId).toBe(CID);

    // 3. request a signed upload URL for this item's photo
    const up = await gql(
      `mutation($c:ID!){requestUploadUrl(cloudId:$c,usedFor:FRESHANDSAVE,fileType:JPEG){url headers{name value}}}`,
      { c: itemId },
      token,
    );
    const uploadUrl = up.data.requestUploadUrl.url as string;
    expect(uploadUrl).toContain("/media/");
    const putPath = new URL(uploadUrl).pathname + new URL(uploadUrl).search;

    // 4. PUT real JPEG bytes to the signed endpoint (through the worker)
    const jpeg = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 1, 2, 3, 4, 5, 0xff, 0xd9,
    ]);
    const putRes = await SELF.fetch("https://example.com" + putPath, {
      method: "PUT",
      headers: { "Content-Type": "image/jpeg" },
      body: jpeg,
    });
    expect(putRes.status).toBe(200);
    const putBody = (await putRes.json()) as any;
    expect(putBody.success).toBe(true);

    // 5. the item's photo now resolves to a served URL
    const after = await gql(
      `query($c:ID!){freshandsave(cloudId:$c){photo{type url}}}`,
      { c: itemId },
      token,
    );
    expect(after.data.freshandsave.photo).toHaveLength(1);
    const photoUrl = after.data.freshandsave.photo[0].url as string;

    // 6. GET the photo back through /media -> exact bytes returned
    const getRes = await SELF.fetch("https://example.com" + new URL(photoUrl).pathname);
    expect(getRes.status).toBe(200);
    expect(getRes.headers.get("content-type")).toContain("image/jpeg");
    const got = new Uint8Array(await getRes.arrayBuffer());
    expect(got.length).toBe(jpeg.length);
    expect([...got]).toEqual([...jpeg]);

    // 6b. the NATIVE APP uploads via multipart/form-data POST — and critically it sends
    //     @Part("file") as a RAW RequestBody with NO filename (plus header values as parts).
    //     Reproduce that EXACT wire format (a filename-less "file" part) as raw bytes.
    const up2 = await gql(
      `mutation($c:ID!){requestUploadUrl(cloudId:$c,usedFor:FRESHANDSAVE,fileType:JPEG){url}}`,
      { c: itemId },
      token,
    );
    const u2 = new URL(up2.data.requestUploadUrl.url);
    const boundary = "----ZwillingBoundary" + Math.random().toString(16).slice(2);
    const enc = new TextEncoder();
    const parts: Uint8Array[] = [
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="Content-Type"\r\n\r\nimage/jpeg\r\n`,
      ),
      // NO filename here — exactly what Retrofit @Part("file") RequestBody produces:
      enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"\r\nContent-Type: image/jpeg\r\n\r\n`,
      ),
      jpeg,
      enc.encode(`\r\n--${boundary}--\r\n`),
    ];
    const total = parts.reduce((n, p) => n + p.length, 0);
    const bodyBytes = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      bodyBytes.set(p, off);
      off += p.length;
    }
    const postRes = await SELF.fetch("https://example.com" + u2.pathname + u2.search, {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body: bodyBytes,
    });
    expect(postRes.status).toBe(200);
    expect(((await postRes.json()) as any).success).toBe(true);
    // and the exact bytes round-trip back
    const after2 = await gql(
      `query($c:ID!){freshandsave(cloudId:$c){photo{url}}}`,
      { c: itemId },
      token,
    );
    const got2 = new Uint8Array(
      await (
        await SELF.fetch(
          "https://example.com" + new URL(after2.data.freshandsave.photo[0].url).pathname,
        )
      ).arrayBuffer(),
    );
    expect([...got2]).toEqual([...jpeg]);

    // 7. clearPhoto removes it (R2 object gone, photo empty)
    const cleared = await gql(
      `mutation($c:ID!){freshandsaveModify(cloudId:$c,change:{clearPhoto:true}){success}}`,
      { c: itemId },
      token,
    );
    expect(cleared.data.freshandsaveModify.success).toBe(true);
    const gone = await gql(
      `query($c:ID!){freshandsave(cloudId:$c){photo{url}}}`,
      { c: itemId },
      token,
    );
    expect(gone.data.freshandsave.photo ?? []).toHaveLength(0);
    const get404 = await SELF.fetch("https://example.com" + new URL(photoUrl).pathname);
    expect(get404.status).toBe(404);
  });
});
