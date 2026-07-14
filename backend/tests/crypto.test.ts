import { encrypt, decrypt, maskString } from '../src/auth/crypto';

function runTests() {
  console.log('🧪 Starting Cryptography Module Tests...\n');
  
  let passedTests = 0;
  let failedTests = 0;

  function assert(condition: boolean, testName: string) {
    if (condition) {
      console.log(`✅ Passed: ${testName}`);
      passedTests++;
    } else {
      console.error(`❌ Failed: ${testName}`);
      failedTests++;
    }
  }

  try {
    // Test 1: Symmetrical Encryption & Decryption
    const originalText = 'MinhaSenhaUltraSegura123!';
    const encrypted = encrypt(originalText);
    const decrypted = decrypt(encrypted);
    
    assert(decrypted === originalText, 'Symmetrical encryption and decryption should match original text');
    assert(encrypted !== originalText, 'Encrypted output should be different from original text');

    // Test 2: Uniqueness (Random IVs)
    const encrypted2 = encrypt(originalText);
    assert(encrypted !== encrypted2, 'Same input encrypted twice should produce different ciphertexts (due to unique IVs)');

    // Test 3: Formatting Structure
    assert(encrypted.includes(':'), 'Encrypted output should contain an IV separator ":"');
    const parts = encrypted.split(':');
    assert(parts.length === 2, 'Encrypted output should split exactly into two parts (IV and Ciphertext)');
    assert(parts[0].length === 32, 'Initialization Vector (IV) should be 16 bytes hex (32 characters)');

    // Test 4: Log Masking
    const textToMask = 'mysecretcookiesvalue';
    const masked = maskString(textToMask);
    assert(masked === 'mys...lue', 'Masking should retain only first and last 3 characters with ellipsis');
    
    const shortText = '123';
    assert(maskString(shortText) === '***', 'Short text masking should fallback to "***"');

    // Test 5: Error Handling
    let errorThrown = false;
    try {
      decrypt('invalid-format-no-colon');
    } catch (e) {
      errorThrown = true;
    }
    assert(errorThrown, 'Decrypting invalid formats should throw an exception');

  } catch (error: any) {
    console.error('💥 Unexpected test runner exception:', error.message || error);
    failedTests++;
  }

  console.log(`\n📊 Test Execution Summary:`);
  console.log(`   - Passed: ${passedTests}`);
  console.log(`   - Failed: ${failedTests}`);

  if (failedTests > 0) {
    process.exit(1);
  } else {
    console.log('\n🌟 All Cryptography Tests Completed Successfully!');
    process.exit(0);
  }
}

runTests();
