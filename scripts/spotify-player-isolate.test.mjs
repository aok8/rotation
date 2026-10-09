import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import { decryptProfile, prepareCall, safeResponse } from './spotify-player-isolate.mjs';
const rotation = {currentIndex: 1, items:Array.from({length:25},(_,i)=>({key:String(i),uri:`spotify:track:ITEM${i}`})),order:Array.from({length:25},(_,i)=>String(i))};
test('isolation creates exactly one requested call and uses current saved order',()=>{
  assert.deepEqual(prepareCall('next','device',rotation),{method:'POST',path:'/me/player/next?device_id=device'});
  assert.deepEqual(prepareCall('play-one','device',rotation).body.uris,['spotify:track:ITEM1']);
  assert.equal(prepareCall('play-window','device',rotation).body.uris.length,20);
  assert.equal(prepareCall('transfer-paused','device',rotation).body.play,false);
  assert.equal(prepareCall('transfer-play','device',rotation).body.play,true);
  assert.throws(()=>prepareCall('next',undefined,rotation));
  assert.throws(()=>prepareCall('play-one','active',rotation));
});
test('shared command output does not contain arbitrary upstream text or playback metadata',()=>{
  const result=safeResponse({error:{status:404,reason:'NO_ACTIVE_DEVICE',message:'No active device found token SECRET device private@example.com'}},'next','device');
  assert.equal(result.error.reason,'NO_ACTIVE_DEVICE');
  assert.doesNotMatch(JSON.stringify(result),/SECRET|private@/);
  const state=safeResponse({device:{id:'privateID',name:'Private name',is_active:true},item:{uri:'spotify:track:PRIVATE',name:'Private song'},is_playing:true},'state','privateID');
  assert.equal(state.selectedDeviceActive,true);
  assert.doesNotMatch(JSON.stringify(state),/privateID|Private|spotify:track/);
});
test('profile loader uses desktop encrypted store format without exposing the token',()=>{
  const secret='a'.repeat(64),iv=Buffer.alloc(12,1),cipher=createCipheriv('aes-256-gcm',createHash('sha256').update(secret).digest(),iv);
  const raw=Buffer.concat([cipher.update(JSON.stringify({session:{tokens:{access:'private-token'}}})),cipher.final()]);
  const encrypted=Buffer.concat([iv,cipher.getAuthTag(),raw]).toString('base64');
  assert.equal(decryptProfile(encrypted,secret).session.tokens.access,'private-token');
  assert.throws(()=>decryptProfile(encrypted,'wrong-secret'));
});
