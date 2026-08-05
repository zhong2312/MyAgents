import { describe, expect, it } from "vitest";

import { createStorageTransaction } from "./storageTransaction";
import { NovelMemoryStorage } from "./testStorage";

describe("StorageTransaction", () => {
  it("全部步骤成功后保留预期的磁盘状态", async () => {
    const storage = new NovelMemoryStorage({
      "index.json": "old index",
      "obsolete.json": "obsolete",
    });
    const transaction = createStorageTransaction(storage);
    transaction.writeText("index.json", "new index", "old index");
    transaction.createText("records/new.json", "new record");
    transaction.remove("obsolete.json");

    await expect(transaction.commit()).resolves.toBeUndefined();
    expect(storage.getText("index.json")).toBe("new index");
    expect(storage.getText("records/new.json")).toBe("new record");
    expect(storage.getText("obsolete.json")).toBeUndefined();
  });

  it("中途 writeText 失败时回滚此前的改写", async () => {
    const storage = new NovelMemoryStorage({
      "first.json": "first old",
      "second.json": "second old",
    });
    storage.failWritePathOnce = "second.json";
    const transaction = createStorageTransaction(storage);
    transaction.writeText("first.json", "first new", "first old");
    transaction.writeText("second.json", "second new", "second old");

    await expect(transaction.commit()).rejects.toThrow(
      "Injected write failure: second.json",
    );
    expect(storage.getText("first.json")).toBe("first old");
    expect(storage.getText("second.json")).toBe("second old");
  });

  it("中途失败时删除此前 createText 创建的文件", async () => {
    const storage = new NovelMemoryStorage({ "index.json": "old" });
    storage.failWritePathOnce = "index.json";
    const transaction = createStorageTransaction(storage);
    transaction.createText("records/new.json", "new");
    transaction.writeText("index.json", "new index", "old");

    await expect(transaction.commit()).rejects.toThrow(
      "Injected write failure: index.json",
    );
    expect(storage.getText("records/new.json")).toBeUndefined();
    expect(storage.getText("index.json")).toBe("old");
  });

  it("expectedContent 不匹配时不产生磁盘变更", async () => {
    const storage = new NovelMemoryStorage({ "index.json": "external" });
    const transaction = createStorageTransaction(storage);
    transaction.writeText("index.json", "new index", "expected");

    await expect(transaction.commit()).rejects.toThrow("File changed externally");
    expect(storage.getText("index.json")).toBe("external");
  });
});
