import { supabase } from '../src/db/client';

async function testSupabaseConnection() {
  console.log('🧪 Starting Supabase Connection and Operations Test...\n');
  console.log(`Checking connection to: ${process.env.SUPABASE_URL}`);

  try {
    // Test 1: Fetch data from casas_apostas
    console.log('1. Testing READ operation on "casas_apostas" table...');
    const { data: readData, error: readError } = await supabase
      .from('casas_apostas')
      .select('id, nome, ativo')
      .limit(5);

    if (readError) {
      console.error('❌ READ failed:', readError.message);
      console.error('Details:', readError);
      process.exit(1);
    }
    console.log('✅ READ successful! Found records:', readData?.length || 0);

    // Test 2: Try to write a test house
    console.log('\n2. Testing WRITE operation (Inserting test record)...');
    const testName = `Test_House_${Date.now()}`;
    const { data: insertData, error: insertError } = await supabase
      .from('casas_apostas')
      .insert([{ nome: testName, url_base: 'https://test-house.com', ativo: false }])
      .select();

    if (insertError) {
      console.error('❌ WRITE failed:', insertError.message);
      console.error('Details:', insertError);
      process.exit(1);
    }
    console.log('✅ WRITE successful! Inserted:', insertData);

    // Test 3: Delete the test house to clean up
    if (insertData && insertData[0]) {
      const insertedId = insertData[0].id;
      console.log(`\n3. Cleaning up (Deleting test record ID: ${insertedId})...`);
      const { error: deleteError } = await supabase
        .from('casas_apostas')
        .delete()
        .eq('id', insertedId);

      if (deleteError) {
        console.error('❌ DELETE failed:', deleteError.message);
      } else {
        console.log('✅ CLEANUP successful! Test record deleted.');
      }
    }

    console.log('\n🌟 Supabase Integration Test Completed Successfully!');
    process.exit(0);

  } catch (error: any) {
    console.error('💥 Unexpected exception during test:', error.message || error);
    process.exit(1);
  }
}

testSupabaseConnection();
