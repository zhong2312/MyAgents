import type { WorkbenchStorage } from "@/workbench-sdk";

type Rollback = () => Promise<void>;

interface TransactionStep {
  execute(): Promise<Rollback>;
}

export interface StorageTransaction {
  /** 登记文本改写；提供 expectedContent 时同时作为 CAS 条件与回滚内容。 */
  writeText(path: string, content: string, expectedContent?: string): void;
  /** 登记文本创建；仅在提交时真正落盘。 */
  createText(path: string, content: string): void;
  /**
   * 登记同名文件移动。WorkbenchStorage 的 move 原语以目标目录为单位，
   * 因此 from 与 to 必须保留相同文件名。
   */
  move(from: string, to: string): void;
  /** 登记永久删除。若后续步骤失败，该步骤会报告为不可逆。 */
  remove(path: string): void;
  commit(): Promise<void>;
}

function fileName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

function parentPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator < 0 ? "" : path.slice(0, separator);
}

function failedMoveMessage(
  result: Awaited<ReturnType<WorkbenchStorage["move"]>>,
  from: string,
  to: string,
): string | null {
  if (result.errors.length) return result.errors[0] ?? "文件移动失败";
  if (result.transfers.length !== 1) {
    return `移动“${from}”时未得到唯一结果`;
  }
  const [transfer] = result.transfers;
  if (transfer?.sourcePath !== from || transfer.targetPath !== to) {
    return `移动“${from}”后的目标路径与预期“${to}”不一致`;
  }
  return null;
}

/**
 * 以 WorkbenchStorage 通用原语编排小型多文件事务。
 *
 * 注册方法不触发 IO；commit 按登记顺序执行。失败时已完成步骤倒序补偿，
 * 补偿再次失败会抛出同时保留原始原因与补偿原因的 AggregateError。
 */
export function createStorageTransaction(
  storage: WorkbenchStorage,
): StorageTransaction {
  const steps: TransactionStep[] = [];
  let sealed = false;

  const register = (step: TransactionStep): void => {
    if (sealed) throw new Error("存储事务已经提交，不能继续登记操作");
    steps.push(step);
  };

  return Object.freeze({
    writeText(path: string, content: string, expectedContent?: string) {
      register({
        async execute() {
          const previousContent =
            expectedContent ?? (await storage.readText(path)).content;
          const written = await storage.writeText(path, content, {
            ...(expectedContent === undefined ? {} : { expectedContent }),
          });
          return async () => {
            await storage.writeText(path, previousContent, {
              expectedContent: written.content,
            });
          };
        },
      });
    },

    createText(path: string, content: string) {
      register({
        async execute() {
          await storage.createText(path, content, { createParents: true });
          return async () => {
            const removed = await storage.remove(path, { permanent: true });
            if (!removed) throw new Error(`无法回滚新建文件：${path}`);
          };
        },
      });
    },

    move(from: string, to: string) {
      if (fileName(from) !== fileName(to)) {
        throw new Error("存储事务移动操作不能变更文件名");
      }
      register({
        async execute() {
          const result = await storage.move([from], parentPath(to));
          const message = failedMoveMessage(result, from, to);
          if (message) throw new Error(message);
          return async () => {
            const reversed = await storage.move([to], parentPath(from));
            const reverseMessage = failedMoveMessage(reversed, to, from);
            if (reverseMessage) throw new Error(reverseMessage);
          };
        },
      });
    },

    remove(path: string) {
      register({
        async execute() {
          const removed = await storage.remove(path, { permanent: true });
          if (!removed) throw new Error(`待删除文件不存在：${path}`);
          return async () => {
            throw new Error(`删除“${path}”不可逆，无法自动回滚`);
          };
        },
      });
    },

    async commit() {
      if (sealed) throw new Error("存储事务只能提交一次");
      sealed = true;
      const rollbacks: Rollback[] = [];
      try {
        for (const step of steps) rollbacks.push(await step.execute());
      } catch (cause) {
        const rollbackErrors: unknown[] = [];
        for (const rollback of rollbacks.reverse()) {
          try {
            await rollback();
          } catch (rollbackCause) {
            rollbackErrors.push(rollbackCause);
          }
        }
        if (rollbackErrors.length) {
          throw new AggregateError(
            [cause, ...rollbackErrors],
            "存储事务提交失败，且自动回滚未完全成功",
          );
        }
        throw cause;
      }
    },
  });
}
