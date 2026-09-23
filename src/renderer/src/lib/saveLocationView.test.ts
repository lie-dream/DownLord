/// <reference types="node" />

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CategoryConfig } from '../../../shared/ipc'
import {
  categoryDirForUrl,
  landingDirForTorrent,
  landingDirForVideo,
  parentDir,
  previewDir,
  torrentDisplayDir
} from './saveLocationView'

const cat = (key: string, extensions: string[], savePath: string): CategoryConfig => ({
  key,
  displayName: key,
  extensions,
  savePath,
  isCustom: false
})

const CATS: CategoryConfig[] = [
  cat('video', ['mp4', 'mkv', 'webm'], 'D:/DL/Videos'),
  cat('audio', ['mp3', 'flac'], 'D:/DL/Music'),
  cat('document', ['pdf', 'docx'], 'D:/DL/Documents'),
  cat('other', [], 'D:/DL')
]

// —— previewDir(镜像 main.explicitDirOf:跟随 / 自定义 / 选回默认目录回落)——

test('previewDir:跟随(pickedDir=null)→ categoryDir', () => {
  assert.equal(previewDir(null, 'D:/DL', 'D:/DL/Videos'), 'D:/DL/Videos')
})

test('previewDir:自定义(pickedDir !== defaultDir)→ pickedDir', () => {
  assert.equal(previewDir('E:/Movies', 'D:/DL', 'D:/DL/Videos'), 'E:/Movies')
})

test('previewDir:浏览选到默认目录(pickedDir === defaultDir)→ 回落 categoryDir(诚实归类)', () => {
  assert.equal(previewDir('D:/DL', 'D:/DL', 'D:/DL/Videos'), 'D:/DL/Videos')
})

// —— categoryDirForUrl(URL 末段扩展名 → 类目录)——

test('categoryDirForUrl:.mp4 直链 → video 类目录', () => {
  assert.equal(categoryDirForUrl('https://x.com/a/clip.mp4', CATS), 'D:/DL/Videos')
})

test('categoryDirForUrl:.pdf 直链 → document 类目录', () => {
  assert.equal(categoryDirForUrl('https://x.com/files/report.pdf', CATS), 'D:/DL/Documents')
})

test('categoryDirForUrl:无扩展名 → null(调用方回落 defaultDir)', () => {
  assert.equal(categoryDirForUrl('https://x.com/watch?v=abc', CATS), null)
})

test('categoryDirForUrl:扩展名无匹配类 → null', () => {
  assert.equal(categoryDirForUrl('https://x.com/a/file.xyz', CATS), null)
})

test('categoryDirForUrl:非法 URL → null', () => {
  assert.equal(categoryDirForUrl('not a url', CATS), null)
})

test('categoryDirForUrl:带查询串仍取路径末段扩展名', () => {
  assert.equal(categoryDirForUrl('https://x.com/a/song.mp3?token=1', CATS), 'D:/DL/Music')
})

// —— parentDir(纯字符串切末位 / 或 \\)——

test('parentDir:正斜杠', () => {
  assert.equal(parentDir('D:/DL/Videos/movie.mp4'), 'D:/DL/Videos')
})

test('parentDir:反斜杠', () => {
  assert.equal(parentDir('E:\\Movies\\clip.mkv'), 'E:\\Movies')
})

test('parentDir:无分隔符 → 原样', () => {
  assert.equal(parentDir('movie.mp4'), 'movie.mp4')
})

// —— landingDirForVideo(显式优先,否则随 audioOnly 取 video / audio 类目录)——

test('landingDirForVideo:跟随 + 视频 → video 类目录', () => {
  assert.equal(
    landingDirForVideo({ audioOnly: false, categories: CATS, explicitDir: null }),
    'D:/DL/Videos'
  )
})

test('landingDirForVideo:跟随 + 仅音频 → audio 类目录', () => {
  assert.equal(
    landingDirForVideo({ audioOnly: true, categories: CATS, explicitDir: null }),
    'D:/DL/Music'
  )
})

test('landingDirForVideo:显式目录优先(忽略 audioOnly)', () => {
  assert.equal(
    landingDirForVideo({ audioOnly: true, categories: CATS, explicitDir: 'E:/X' }),
    'E:/X'
  )
})

// —— v0.3 Task 1:torrent 整包落点显示(spec §10.3)——

test('torrentDisplayDir:正斜杠目录 → <defaultDir>/Torrents', () => {
  assert.equal(torrentDisplayDir('D:/DL'), 'D:/DL/Torrents')
})

test('torrentDisplayDir:纯反斜杠 Windows 目录 → 按反斜杠分隔符拼', () => {
  assert.equal(torrentDisplayDir('D:\\Downloads'), 'D:\\Downloads\\Torrents')
})

test('torrentDisplayDir:空 defaultDir → 仅 Torrents(不产生前导分隔符)', () => {
  assert.equal(torrentDisplayDir(''), 'Torrents')
})

// —— v0.3 Task 2:多文件种子落点显示 <Torrents>/<种子名>(spec §7)——

test('landingDirForTorrent:正斜杠 → <defaultDir>/Torrents/<name>', () => {
  assert.equal(landingDirForTorrent('D:/DL', 'Show.S01'), 'D:/DL/Torrents/Show.S01')
})

test('landingDirForTorrent:纯反斜杠 Windows 目录 → 按反斜杠拼', () => {
  assert.equal(
    landingDirForTorrent('D:\\Downloads', 'Show.S01'),
    'D:\\Downloads\\Torrents\\Show.S01'
  )
})

test('landingDirForTorrent:name 空 → 退回 Torrents 目录', () => {
  assert.equal(landingDirForTorrent('D:/DL', ''), 'D:/DL/Torrents')
})
