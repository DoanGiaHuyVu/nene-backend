import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
const exec=promisify(execFile);

test('real Git publication is linear, retry-safe, excludes dependencies and never overwrites unexpected history',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'nene-publish-test-'));
  const remote=path.join(root,'remote.git'),artifact=path.join(root,'artifact'),ignore=path.join(root,'ignore');
  const before=new Set((await fs.readdir('/tmp')).filter(n=>n.startsWith('nene-github-')));
  try{
    await exec('git',['init','--bare',remote]);
    await fs.mkdir(path.join(artifact,'app','node_modules'),{recursive:true});
    await fs.mkdir(path.join(artifact,'app','.git'),{recursive:true});
    await fs.writeFile(path.join(artifact,'app','index.txt'),'first revision');
    await fs.writeFile(path.join(artifact,'app','node_modules','huge-file'),'excluded');
    await fs.writeFile(path.join(artifact,'app','.env'),'secret');
    await fs.writeFile(path.join(artifact,'app','.git','config'),'untrusted');
    await fs.writeFile(ignore,'node_modules/\n.env\n');
    process.env.NENE_GITHUB_REPO=remote;process.env.NENE_PUBLISH_IGNORE=ignore;
    const { publishArtifactToGithub }=await import('../dist/github.js');
    const firstId=randomUUID(),secondId=randomUUID(),branch=`task/${firstId.slice(0,8)}`;
    const first=await publishArtifactToGithub(firstId,artifact,{branch});
    const retry=await publishArtifactToGithub(firstId,artifact,{branch});assert.deepEqual(retry,first);
    const files=(await exec('git',['--git-dir',remote,'ls-tree','-r','--name-only',branch])).stdout.trim();
    assert.equal(files,'app/index.txt');
    await fs.writeFile(path.join(artifact,'app','index.txt'),'second revision');
    const second=await publishArtifactToGithub(secondId,artifact,{branch,expectedCommit:first.commit});
    assert.equal(second.branch,first.branch);assert.notEqual(second.commit,first.commit);
    const parent=(await exec('git',['--git-dir',remote,'rev-parse',`${second.commit}^`])).stdout.trim();assert.equal(parent,first.commit);
    assert.deepEqual(await publishArtifactToGithub(secondId,artifact,{branch,expectedCommit:first.commit}),second);
    await fs.writeFile(path.join(artifact,'app','index.txt'),'third revision');
    await assert.rejects(publishArtifactToGithub(randomUUID(),artifact,{branch,expectedCommit:first.commit}),/changed since/);
    assert.equal((await exec('git',['--git-dir',remote,'rev-parse',branch])).stdout.trim(),second.commit);
    // A no-op continuation keeps the same commit, including when retried after a crash.
    await fs.writeFile(path.join(artifact,'app','index.txt'),'second revision');
    const noopId=randomUUID();const noop=await publishArtifactToGithub(noopId,artifact,{branch,expectedCommit:second.commit});
    assert.equal(noop.commit,second.commit);assert.deepEqual(await publishArtifactToGithub(noopId,artifact,{branch,expectedCommit:second.commit}),noop);
    assert.ok((await fs.readdir('/tmp')).filter(n=>n.startsWith('nene-github-')).every(n=>before.has(n)));
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
