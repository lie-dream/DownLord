/**
 * `ChannelHttpFactory` 的真实 node 实现(v0.4 Task 3 · spec §6.2)。
 *
 * `channelServer.ts` 不 import `node:http` 的**值**(只 import 类型),故可被注入 fake;
 * 主进程装配与集成测试注入本薄封装起**真服务**(集成测试仍只打回环,零外网,spec §6.4)。
 */
import { createServer } from 'node:http'
import type { ChannelHttpFactory } from './channelServer'

export const nodeHttpFactory: ChannelHttpFactory = (listener) => createServer(listener)
